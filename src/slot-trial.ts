// Qwen3.5-4B controlled two-slot trial runner (plan
// docs/plans/2026-10-06-qwen35-4b-two-slot-trial.md, Task 1). A bounded client-side
// harness — NOT a model-serving framework: it never starts, stops, downloads or changes
// a model. It streams OpenAI-compatible requests against an already-running endpoint,
// attributes every sample by explicit request identifier (never completion order),
// reconstructs fragmented tool-call deltas before handing them to the deterministic mock
// engine (./mock-engine.js), enforces the trial's memory floors and duration budget, and
// aggregates latency through the shared nearest-rank summarizer (./latency.js).
//
// Timing is DELTA-level, not exact per-token: one server event can carry multiple tokens,
// so first-output and gap timings are recorded per received delta, across three channels
// (content, tool-call arguments, reasoning) tracked separately.
//
// Everything effectful is injected — transport, clock, memory sampler — so the offline
// tests (./slot-trial.test.ts) never touch frame, OpenRouter, murmur8, n8n or real tools.

import { runTool, type MockMap } from './mock-engine.js';
import { summarize, type LatencyRecord, type LatencySummary } from './latency.js';
import { isDeepStrictEqual } from 'node:util';
import type { ChatCompletionCreateParams } from 'openai/resources/chat/completions';

export type TrialWorkload = 'title' | 'fill' | 'portal' | 'isolation';
export type TrialCacheState = 'cold' | 'warm' | 'unverified';
export type TrialChannel = 'content' | 'tool_arguments' | 'reasoning';

/** What the runner reads from the server's `/props` (or an equivalent probe) before any request. */
export interface PreflightInfo {
  slots: number | null;
  contextPerSlot: number | null;
  modelPath: string | null;
  attentionCacheType: string | null;
  kvUnified: boolean | null;
}

/** The subset of an OpenAI streaming chunk this runner reads. */
export interface TrialStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string | null;
        function?: { name?: string | null; arguments?: string | null } | null;
      } | null> | null;
    } | null;
    finish_reason?: string | null;
  } | null> | null;
  usage?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    prompt_tokens_details?: { cached_tokens?: number | null } | null;
  } | null;
}

export interface TrialStream {
  /** HTTP status of the streaming response (null when the transport cannot report one). */
  status: number | null;
  chunks: AsyncIterable<TrialStreamChunk>;
}

/** The messages actually sent for one request: the request's own copy plus its bound. */
export interface TrialSampling {
  temperature?: number;
  topP?: number;
  seed?: number;
  responseFormat?: ChatCompletionCreateParams['response_format'];
}

export interface TrialRequestWirePayload extends TrialSampling {
  requestIdentifier: string;
  maxOutputTokens: number;
  messages: unknown[];
  tools: unknown[];
}

export interface TrialTransport {
  preflight(signal?: AbortSignal): Promise<PreflightInfo>;
  /**
   * Begin a streaming completion. `payload` is already request-scoped (the runner copies
   * every mutable array per request — the transport may mutate what it is handed).
   * Implementations MUST disable automatic HTTP retries and never fall back to another
   * backend; the real adapter builds the OpenAI client with maxRetries: 0.
   */
  stream(payload: TrialRequestWirePayload, signal: AbortSignal): Promise<TrialStream>;
}

export interface MemorySample {
  takenAtMilliseconds: number;
  hostAvailableMebibytes: number | null;
  freshProcessDeviceLocalBudgetMebibytes: number | null;
}

export type MemorySampler = (signal?: AbortSignal) => Promise<MemorySample>;

export interface MemoryFloors {
  hostAvailableMebibytesMinimum?: number;
  freshProcessDeviceLocalBudgetMebibytesMinimum?: number;
}

export interface ExpectedToolCall {
  name: string;
  /** Exact JSON arguments; runtime validation rejects omitted arguments. */
  arguments?: Record<string, unknown>;
}

export interface TrialRequest extends TrialSampling {
  requestIdentifier: string;
  workload: TrialWorkload;
  cacheState: TrialCacheState;
  /** Fresh mutable array PER REQUEST — the runner copies it before use; never share one across peers. */
  messages: unknown[];
  tools?: unknown[];
  /** Nonempty legacy function maps are rejected: their closure state cannot be copied. */
  mocks?: MockMap;
  createMocks?: () => MockMap;
  expectedToolCalls?: ExpectedToolCall[];
  expectedContent?: string;
  /** Exact synthetic answer; also checks the fill schema's intended semantics without a schema engine. */
  expectedJson?: Record<string, unknown>;
  /** Markers belonging to OTHER concurrent requests; any appearance in this response is contamination. */
  foreignMarkers: string[];
  /** This request's marker must occur in content, reasoning, or actual tool arguments. */
  ownMarker?: string;
  maxOutputTokens: number;
  /** Cancel this stream after N non-empty output deltas (cancellation-isolation pairs). */
  cancelAfterDelta?: number;
  cancelAfterMilliseconds?: number;
}

export interface ReconstructedToolCall {
  index: number;
  id: string | null;
  name: string | null;
  argumentsJson: string;
  /** Parsed arguments, or null when the reconstructed JSON did not parse (malformed). */
  arguments: Record<string, unknown> | null;
  /** Mock-engine result (parsed back to an object when it is JSON), or null when never executed. */
  mockResult: unknown;
}

export interface SlotTrialSample {
  requestIdentifier: string;
  workload: TrialWorkload;
  profile: string;
  cacheState: TrialCacheState;
  startedAtMilliseconds: number | null;
  /** First NON-EMPTY output delta on any channel, monotonic ms. */
  firstOutputDeltaMilliseconds: number | null;
  completedAtMilliseconds: number | null;
  /** Largest gap between consecutive non-empty output deltas (delta-level, not per token). */
  maximumOutputDeltaGapMilliseconds: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  outcome: 'completed' | 'cancelled' | 'failed' | 'not_started';
  foreignMarkers: string[];
  validationErrors: string[];
  // Additions required by the plan's acceptance criteria (3):
  responseStatus: number | null;
  finishReason: string | null;
  sawContentDelta: boolean;
  sawToolArgumentsDelta: boolean;
  sawReasoningDelta: boolean;
  reconstructedToolCalls: ReconstructedToolCall[] | null;
  content: string;
  reasoning: string;
}

export interface SlotTrialOptions {
  transport: TrialTransport;
  profileLabel: string;
  /** Monotonic millisecond clock; defaults to performance.now. */
  now?: () => number;
  memorySampler?: MemorySampler;
  memoryFloors?: MemoryFloors;
  expectedSlots?: number;
  expectedContextPerSlot?: number;
  expectedModelPath?: string;
  expectedAttentionCacheType?: string;
  expectedKvUnified?: boolean;
  maxConcurrency: number;
  maxRequests: number;
  durationBudgetMs: number;
  memoryIntervalMilliseconds?: number;
  memorySampleTimeoutMilliseconds?: number;
  onPreflight?: (preflight: PreflightInfo) => void;
  onMemorySample?: (sample: MemorySample) => void;
  onSample?: (sample: SlotTrialSample) => void;
  onDelta?: (delta: { requestIdentifier: string; channel: TrialChannel; text: string; atMilliseconds: number }) => void;
  requests: TrialRequest[];
}

export interface SlotTrialReport {
  profile: string;
  abortedBeforeRequests: boolean;
  preflightMismatchReasons: string[];
  preflight: PreflightInfo | null;
  samples: SlotTrialSample[];
  memorySamples: MemorySample[];
  safetyBreaches: string[];
  /** Completion latency via the shared nearest-rank summarizer, keyed `${workload}|${cacheState}`. */
  latencySummaries: Record<string, LatencySummary>;
  /** Valid completed single turns only: supplied output tokens / total elapsed seconds. */
  completedTokensPerSecond: number;
  durationBudgetExceeded: boolean;
  successful: boolean;
  outcomeCounts: Record<SlotTrialSample['outcome'] | 'total', number>;
}

/** The plan's hard bound: more than two requests are never in flight. */
export const MAX_TRIAL_CONCURRENCY = 2;

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse a mock-engine result back to an object when possible, else keep the raw string. */
function parseMockResult(result: string): unknown {
  try {
    const parsed: unknown = JSON.parse(result);
    return parsed;
  } catch {
    return result;
  }
}

function newSample(profileLabel: string): SlotTrialSample {
  return {
    requestIdentifier: '',
    workload: 'title',
    profile: profileLabel,
    cacheState: 'cold',
    startedAtMilliseconds: null,
    firstOutputDeltaMilliseconds: null,
    completedAtMilliseconds: null,
    maximumOutputDeltaGapMilliseconds: null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    outcome: 'not_started',
    foreignMarkers: [],
    validationErrors: [],
    responseStatus: null,
    finishReason: null,
    sawContentDelta: false,
    sawToolArgumentsDelta: false,
    sawReasoningDelta: false,
    reconstructedToolCalls: null,
    content: '',
    reasoning: '',
  };
}

function checkPreflight(options: SlotTrialOptions, preflight: PreflightInfo): string[] {
  const reasons: string[] = [];
  if (options.expectedSlots !== undefined && preflight.slots !== options.expectedSlots) {
    reasons.push(`preflight reported ${String(preflight.slots)} slot(s), expected ${String(options.expectedSlots)}`);
  }
  if (options.expectedContextPerSlot !== undefined && preflight.contextPerSlot !== options.expectedContextPerSlot) {
    reasons.push(`preflight reported ${String(preflight.contextPerSlot)} context per slot, expected ${String(options.expectedContextPerSlot)}`);
  }
  if (options.expectedModelPath !== undefined && preflight.modelPath !== options.expectedModelPath) {
    reasons.push(`preflight reported model '${String(preflight.modelPath)}', expected '${options.expectedModelPath}'`);
  }
  if (options.expectedAttentionCacheType !== undefined && preflight.attentionCacheType !== options.expectedAttentionCacheType) {
    reasons.push(`preflight reported attention cache '${String(preflight.attentionCacheType)}', expected '${options.expectedAttentionCacheType}'`);
  }
  if (options.expectedKvUnified !== undefined && preflight.kvUnified !== options.expectedKvUnified) {
    reasons.push(`preflight reported kvUnified ${String(preflight.kvUnified)}, expected ${String(options.expectedKvUnified)}`);
  }
  return reasons;
}

function floorBreaches(sample: MemorySample | null, floors: MemoryFloors | undefined, phase: string): string[] {
  if (!floors) return [];
  const breaches: string[] = [];
  const host = sample?.hostAvailableMebibytes;
  const device = sample?.freshProcessDeviceLocalBudgetMebibytes;
  if (floors.hostAvailableMebibytesMinimum !== undefined) {
    if (host == null || !Number.isFinite(host) || host < floors.hostAvailableMebibytesMinimum) {
      breaches.push(
        `${phase}: host available memory ${String(sample?.hostAvailableMebibytes)} MiB is unavailable or below the ` +
          `${String(floors.hostAvailableMebibytesMinimum)} MiB floor`,
      );
    }
  }
  if (floors.freshProcessDeviceLocalBudgetMebibytesMinimum !== undefined) {
    if (device == null || !Number.isFinite(device) || device < floors.freshProcessDeviceLocalBudgetMebibytesMinimum) {
      breaches.push(
        `${phase}: fresh-process device-local budget ${String(sample?.freshProcessDeviceLocalBudgetMebibytes)} MiB is unavailable or below the ` +
          `${String(floors.freshProcessDeviceLocalBudgetMebibytesMinimum)} MiB floor`,
      );
    }
  }
  return breaches;
}

function positiveInteger(value: number, name: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
}

/** Reject invalid scope before invoking any injected effect. */
export function validateSlotTrialOptions(options: SlotTrialOptions): void {
  positiveInteger(options.maxConcurrency, 'concurrency', MAX_TRIAL_CONCURRENCY);
  positiveInteger(options.maxRequests, 'maximum requests', 10000);
  positiveInteger(options.durationBudgetMs, 'duration', 5400000);
  positiveInteger(options.memoryIntervalMilliseconds ?? 1000, 'memory interval', 60000);
  positiveInteger(options.memorySampleTimeoutMilliseconds ?? 5000, 'memory timeout', 60000);
  if (options.expectedSlots !== undefined) positiveInteger(options.expectedSlots, 'expected slots', 2);
  if (options.expectedContextPerSlot !== undefined) positiveInteger(options.expectedContextPerSlot, 'expected context', 1048576);
  for (const floor of Object.values(options.memoryFloors ?? {})) {
    if (!Number.isFinite(floor) || floor <= 0) throw new Error('memory floors must be positive finite numbers');
    if (!options.memorySampler) throw new Error('memory floors require a memory sampler');
  }
  if (!Array.isArray(options.requests) || options.requests.length === 0 || options.requests.length > options.maxRequests) {
    throw new Error('requests must be nonempty and within maximum requests');
  }
  const identifiers = new Set<string>();
  for (const request of options.requests) {
    if (!request || typeof request.requestIdentifier !== 'string' || !request.requestIdentifier.trim() || identifiers.has(request.requestIdentifier)) {
      throw new Error('request identifiers must be nonempty and unique');
    }
    identifiers.add(request.requestIdentifier);
    positiveInteger(request.maxOutputTokens, 'output budget', options.expectedContextPerSlot ?? 24576);
    if (request.cancelAfterDelta !== undefined) positiveInteger(request.cancelAfterDelta, 'cancellation delta', 1000000);
    if (request.cancelAfterMilliseconds !== undefined) positiveInteger(request.cancelAfterMilliseconds, 'cancellation duration', options.durationBudgetMs);
    if (!Array.isArray(request.messages) || !Array.isArray(request.foreignMarkers)) throw new Error('messages and foreignMarkers must be arrays');
    if (request.mocks && Object.keys(request.mocks).length) throw new Error('use a createMocks factory for fresh per-request closure state');
    if (request.createMocks !== undefined && typeof request.createMocks !== 'function') throw new Error('createMocks must be a factory');
    if (!['title', 'fill', 'portal', 'isolation'].includes(request.workload) || !['cold', 'warm', 'unverified'].includes(request.cacheState)) throw new Error('invalid workload or cache state');
    if (request.tools !== undefined && !Array.isArray(request.tools)) throw new Error('tools must be an array');
    if (!request.foreignMarkers.every((marker) => typeof marker === 'string' && marker.length > 0)) throw new Error('foreign markers must be nonempty strings');
    if (request.expectedToolCalls !== undefined && (!Array.isArray(request.expectedToolCalls) || !request.expectedToolCalls.every((call) => typeof call.name === 'string' && isObject(call.arguments)))) {
      throw new Error('expected tool calls require names and exact object arguments');
    }
    if (request.expectedJson !== undefined && !isObject(request.expectedJson)) throw new Error('expectedJson must be an object');
    if (request.temperature !== undefined && (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2)) throw new Error('temperature must be between zero and two');
    if (request.topP !== undefined && (!Number.isFinite(request.topP) || request.topP <= 0 || request.topP > 1)) throw new Error('topP must be greater than zero and at most one');
    if (request.seed !== undefined && (!Number.isSafeInteger(request.seed) || request.seed < 0 || request.seed > 4294967294)) throw new Error('seed must be a fixed unsigned integer (not the random sentinel)');
    if (request.responseFormat !== undefined && (!isObject(request.responseFormat) || !['text', 'json_object', 'json_schema'].includes(String(request.responseFormat.type)))) throw new Error('invalid responseFormat');
    // Check serialization before preflight rather than failing halfway through a run.
    JSON.stringify(request);
  }
}

/** Race every potentially stalled effect, not just the initial HTTP response. */
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error(String(signal.reason ?? 'cancelled')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Bounded, single-turn requests. Aborts cancel this client's transport, never a service. */
export async function runSlotTrial(options: SlotTrialOptions): Promise<SlotTrialReport> {
  validateSlotTrialOptions(options);
  const now = options.now ?? ((): number => performance.now());
  const report: SlotTrialReport = {
    profile: options.profileLabel,
    abortedBeforeRequests: false,
    preflightMismatchReasons: [],
    preflight: null,
    samples: [],
    memorySamples: [],
    safetyBreaches: [],
    latencySummaries: {},
    completedTokensPerSecond: 0,
    durationBudgetExceeded: false,
    successful: false,
    outcomeCounts: { total: options.requests.length, completed: 0, failed: 0, cancelled: 0, not_started: 0 },
  };

  const startedAtMs = now();
  const runController = new AbortController();
  const deadline = setTimeout(() => {
    report.durationBudgetExceeded = true;
    runController.abort('duration budget exceeded');
  }, options.durationBudgetMs);
  let monitorTimer: ReturnType<typeof setTimeout> | undefined;
  let monitoring = true;
  let memoryPending: Promise<void> | undefined;
  const queue = [...options.requests];
  const inFlight = new Set<Promise<void>>();

  function checkMemory(phase: string): Promise<void> {
    if (!options.memorySampler || runController.signal.aborted) return Promise.resolve();
    if (memoryPending) return memoryPending;
    memoryPending = (async () => {
      const samplingController = new AbortController();
      const signal = AbortSignal.any([runController.signal, samplingController.signal]);
      const timeout = setTimeout(() => samplingController.abort('memory sampler timeout'), options.memorySampleTimeoutMilliseconds ?? 5000);
      try {
        const memorySample = await abortable(options.memorySampler!(signal), signal);
        report.memorySamples.push(memorySample);
        options.onMemorySample?.(deepCopy(memorySample));
        const breaches = floorBreaches(memorySample, options.memoryFloors, phase);
        report.safetyBreaches.push(...breaches);
        if (breaches.length) runController.abort('memory floor breached');
      } catch (error) {
        if (!runController.signal.aborted) {
          report.safetyBreaches.push(`${phase}: memory sampling failed: ${String(error)}`);
          runController.abort('memory sampling failed');
        }
      } finally {
        clearTimeout(timeout);
      }
    })().finally(() => { memoryPending = undefined; });
    return memoryPending;
  }

  function scheduleMonitor(): void {
    if (!monitoring || !options.memorySampler || runController.signal.aborted) return;
    monitorTimer = setTimeout(() => {
      void checkMemory('runtime').then(scheduleMonitor);
    }, options.memoryIntervalMilliseconds ?? 1000);
  }

  const launch = (request: TrialRequest): Promise<void> => {
    const promise = runOneRequest(request).then(() => {
      inFlight.delete(promise);
    });
    inFlight.add(promise);
    return promise;
  };

  async function runOneRequest(request: TrialRequest): Promise<void> {
    const sample: SlotTrialSample = {
      ...newSample(options.profileLabel),
      requestIdentifier: request.requestIdentifier,
      workload: request.workload,
      cacheState: request.cacheState,
    };
    report.samples.push(sample);

    // Fresh mutable copies per request — never share runLoop-style mutated arrays.
    const payload: TrialRequestWirePayload = {
      requestIdentifier: request.requestIdentifier,
      maxOutputTokens: request.maxOutputTokens,
      messages: deepCopy(request.messages),
      tools: deepCopy(request.tools ?? []),
      temperature: request.temperature,
      topP: request.topP,
      seed: request.seed,
      responseFormat: request.responseFormat === undefined ? undefined : deepCopy(request.responseFormat),
    };
    let mocks: MockMap = {};

    sample.startedAtMilliseconds = now();
    const controller = new AbortController();
    const signal = AbortSignal.any([runController.signal, controller.signal]);
    const cancellationTimer = request.cancelAfterMilliseconds === undefined ? undefined
      : setTimeout(() => controller.abort('scheduled cancellation'), request.cancelAfterMilliseconds);
    let nonEmptyDeltas = 0;
    let lastDeltaAt: number | null = null;
    let maxGap: number | null = null;
    let firstDeltaAt: number | null = null;

    const noteDelta = (channel: TrialChannel, text: string): void => {
      if (text.length === 0) return;
      const at = now();
      if (channel === 'content') sample.sawContentDelta = true;
      if (channel === 'tool_arguments') sample.sawToolArgumentsDelta = true;
      if (channel === 'reasoning') sample.sawReasoningDelta = true;
      if (channel === 'content') sample.content += text;
      if (channel === 'reasoning') sample.reasoning += text;
      if (firstDeltaAt === null) firstDeltaAt = at;
      if (lastDeltaAt !== null) maxGap = Math.max(maxGap ?? 0, at - lastDeltaAt);
      lastDeltaAt = at;
      nonEmptyDeltas += 1;
      options.onDelta?.({ requestIdentifier: request.requestIdentifier, channel, text, atMilliseconds: at });
      if (request.cancelAfterDelta !== undefined && nonEmptyDeltas >= request.cancelAfterDelta) {
        controller.abort();
      }
    };

    // Tool-call fragments keyed by index, reconstructed at stream end.
    const fragments = new Map<number, { id: string | null; name: string | null; argumentsParts: string[] }>();
    let streamFailed = false;

    try {
      mocks = request.createMocks?.() ?? {};
      const stream = await abortable(options.transport.stream(payload, signal), signal);
      sample.responseStatus = stream.status;
      if (stream.status === null || stream.status < 200 || stream.status >= 300) {
        streamFailed = true;
        sample.validationErrors.push(`streaming request failed with HTTP ${String(stream.status)}`);
      } else {
        const iterator = stream.chunks[Symbol.asyncIterator]();
        try {
          while (!signal.aborted) {
            const next = await abortable(iterator.next(), signal);
            if (next.done) break;
            const chunk = next.value;
            const choice = chunk.choices?.[0];
            const delta = choice?.delta;
            if (delta?.content) noteDelta('content', delta.content);
            if (delta?.reasoning_content) noteDelta('reasoning', delta.reasoning_content);
            for (const call of delta?.tool_calls ?? []) {
              if (!call) continue;
              const index = call.index ?? 0;
              const entry = fragments.get(index) ?? { id: null, name: null, argumentsParts: [] };
              if (call.id) entry.id = call.id;
              if (call.function?.name) entry.name = (entry.name ?? '') + call.function.name;
              if (call.function?.arguments) {
                entry.argumentsParts.push(call.function.arguments);
                noteDelta('tool_arguments', call.function.arguments);
              }
              fragments.set(index, entry);
            }
            if (choice?.finish_reason) sample.finishReason = choice.finish_reason;
            if (chunk.usage) {
              sample.inputTokens = chunk.usage.prompt_tokens ?? null;
              sample.outputTokens = chunk.usage.completion_tokens ?? null;
              sample.cachedInputTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? null;
            }
          }
        } finally {
          // Some transports cannot settle return() after a stalled next(). Never await it.
          if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {});
        }
      }
    } catch (error) {
      streamFailed = true;
      if (isObject(error) && typeof error.status === 'number') sample.responseStatus = error.status;
      if (!controller.signal.aborted) sample.validationErrors.push(`stream error: ${String(error instanceof Error ? error.message : error)}`);
    } finally {
      clearTimeout(cancellationTimer);
    }

    sample.firstOutputDeltaMilliseconds = firstDeltaAt;
    sample.completedAtMilliseconds = now();
    sample.maximumOutputDeltaGapMilliseconds = maxGap;

    if (controller.signal.aborted) {
      // Client cancellation is recorded; server slot release requires a separate probe.
      sample.outcome = 'cancelled';
    } else if (streamFailed) {
      sample.outcome = 'failed';
    } else if (!sample.sawContentDelta && !sample.sawToolArgumentsDelta && !sample.sawReasoningDelta) {
      // An empty stream is not a successful completion.
      sample.outcome = 'failed';
      sample.validationErrors.push('empty stream: no content, reasoning or tool-argument deltas received');
    } else {
      sample.outcome = 'completed';
    }

    // Reconstruct tool calls; only well-formed ones go to the mock engine. A cancelled
    // stream is not validated — its reconstruction would be a truncated fragment.
    if (fragments.size > 0 && sample.outcome !== 'cancelled') {
      sample.reconstructedToolCalls = [];
      for (const [index, entry] of [...fragments.entries()].sort((a, b) => a[0] - b[0])) {
        const argumentsJson = entry.argumentsParts.join('');
        let parsed: Record<string, unknown> | null = null;
        let mockResult: unknown = null;
        try {
          const value: unknown = JSON.parse(argumentsJson);
          if (!isObject(value)) throw new Error('arguments must be a JSON object');
          parsed = value;
          const offered = payload.tools.some((tool) => isObject(tool) && isObject(tool.function) && tool.function.name === entry.name);
          if (!offered || !entry.id || !entry.name) throw new Error('unknown tool or missing call identity');
          mockResult = parseMockResult(runTool(entry.name ?? '', parsed, mocks));
          if (isObject(mockResult) && ('error' in mockResult || mockResult.isError === true)) throw new Error('mock returned an error');
        } catch (error) {
          sample.validationErrors.push(`malformed or incorrect tool call '${entry.name ?? 'unknown'}': ${String(error)}`);
          sample.outcome = 'failed';
        }
        sample.reconstructedToolCalls.push({ index, id: entry.id, name: entry.name, argumentsJson, arguments: parsed, mockResult });
      }
    }

    // Validation: expected tool calls.
    if (sample.outcome !== 'cancelled') {
      const reconstructed = sample.reconstructedToolCalls ?? [];
      const expected = request.expectedToolCalls ?? [];
      if (reconstructed.length !== expected.length || reconstructed.some((call, index) => call.name !== expected[index]?.name || !jsonEqual(call.arguments, expected[index]?.arguments))) {
        sample.validationErrors.push('tool calls did not match the exact expected sequence and arguments');
      }
      const requiredFinishReason = reconstructed.length ? 'tool_calls' : 'stop';
      if (sample.finishReason !== requiredFinishReason) sample.validationErrors.push(`invalid terminal finish reason: ${String(sample.finishReason)}`);
      if (!reconstructed.length && !sample.content.trim()) sample.validationErrors.push('empty answer: reasoning is not response content');
      if (request.workload === 'title' && (!/^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+){1,2}$/u.test(sample.content.trim()) || sample.content.trim().length > 30 || reconstructed.length)) {
        sample.validationErrors.push('title must be a two or three word label, at most 30 characters, without punctuation');
      }
      if (request.expectedContent !== undefined && sample.content.trim() !== request.expectedContent) sample.validationErrors.push('content did not match the expected answer');
      if (request.workload === 'fill' || request.expectedJson !== undefined) {
        try {
          const value: unknown = JSON.parse(sample.content);
          if (!isObject(value) || request.expectedJson === undefined || !jsonEqual(value, request.expectedJson)) throw new Error('incorrect fill');
        } catch {
          sample.validationErrors.push('fill content must match the exact expected JSON object');
        }
      }
    }

    // Match only model output, keeping channels/calls separate across interleaved deltas.
    // Decoded arguments cover JSON escapes; mocks and expected values are not evidence.
    const responseTexts = [
      sample.content,
      sample.reasoning,
      ...[...fragments.values()].map((entry) => entry.argumentsParts.join('')),
      ...(sample.reconstructedToolCalls ?? []).flatMap((call) => call.arguments === null ? [] : [JSON.stringify(call.arguments)]),
    ];
    for (const marker of request.foreignMarkers) {
      if (responseTexts.some((text) => text.includes(marker))) sample.foreignMarkers.push(marker);
    }
    const ownMarker = request.ownMarker;
    if (sample.outcome !== 'cancelled' && ownMarker !== undefined && !responseTexts.some((text) => text.includes(ownMarker))) {
      sample.validationErrors.push(`own marker '${ownMarker}' did not appear in response content, reasoning or tool arguments`);
    }

    // Validation: warm/cold labelling vs observed cache usage (only when usage was supplied).
    if (sample.cachedInputTokens !== null && request.cacheState === 'cold' && sample.cachedInputTokens > 0) {
      sample.validationErrors.push(`request labelled cold reported ${String(sample.cachedInputTokens)} cached input tokens (label mismatch)`);
    }
    for (const count of [sample.inputTokens, sample.outputTokens, sample.cachedInputTokens]) {
      if (count !== null && (!Number.isSafeInteger(count) || count < 0)) sample.validationErrors.push('invalid token usage');
    }
    if (sample.outputTokens !== null && sample.outputTokens > request.maxOutputTokens) sample.validationErrors.push('reported output exceeded the request budget');
    if (sample.validationErrors.length || sample.foreignMarkers.length) sample.outcome = 'failed';

    // Close admission before callbacks or sampling can yield. Global aborts fail active
    // neighbors; a clean request-local cancellation does not stop the run.
    if (sample.outcome === 'failed') runController.abort(`hard correctness failure in request '${request.requestIdentifier}'`);
    options.onSample?.(deepCopy(sample));

    await checkMemory('runtime');
  }

  try {
    const preflight = await abortable(options.transport.preflight(runController.signal), runController.signal);
    report.preflight = preflight;
    options.onPreflight?.(deepCopy(preflight));
    report.preflightMismatchReasons = checkPreflight(options, preflight);
    if (report.preflightMismatchReasons.length) runController.abort('preflight mismatch');
    await checkMemory('pre-run');
    scheduleMonitor();
    while (queue.length > 0 || inFlight.size > 0) {
      while (queue.length > 0 && inFlight.size < options.maxConcurrency) {
        if (now() - startedAtMs >= options.durationBudgetMs) {
          report.durationBudgetExceeded = true;
          runController.abort('duration budget exceeded');
        }
        if (runController.signal.aborted) break;
        const next = queue.shift() as TrialRequest;
        void launch(next);
      }
      if (inFlight.size === 0) break;
      await Promise.race(inFlight);
    }
  } catch (error) {
    report.safetyBreaches.push(`trial failed: ${String(error)}`);
    runController.abort('trial failed');
    await Promise.allSettled(inFlight);
  } finally {
    monitoring = false;
    clearTimeout(monitorTimer);
    if (memoryPending) await memoryPending;
    clearTimeout(deadline);
    for (const pending of queue) {
      const sample = { ...newSample(options.profileLabel), requestIdentifier: pending.requestIdentifier, workload: pending.workload, cacheState: pending.cacheState };
      report.samples.push(sample);
      options.onSample?.(deepCopy(sample));
    }
    report.abortedBeforeRequests = report.samples.every((sample) => sample.outcome === 'not_started');
  }

  // Aggregate latency through the shared nearest-rank summarizer (./latency.js), per workload|cacheState.
  const recordsByGroup = new Map<string, LatencyRecord[]>();
  for (const sample of report.samples) {
    if (sample.outcome !== 'completed') continue;
    if (sample.startedAtMilliseconds === null || sample.completedAtMilliseconds === null) continue;
    const key = `${sample.workload}|${sample.cacheState}`;
    const list = recordsByGroup.get(key) ?? [];
    list.push({
      requestId: sample.requestIdentifier,
      stage: 'text-api',
      durationMs: sample.completedAtMilliseconds - sample.startedAtMilliseconds,
      promptTokens: sample.inputTokens ?? 0,
      cachedPromptTokens: sample.cachedInputTokens ?? 0,
      outputTokens: sample.outputTokens ?? 0,
      modelCalls: 1,
      toolTimeMs: 0,
      config: options.profileLabel,
    });
    recordsByGroup.set(key, list);
  }
  for (const [key, list] of recordsByGroup) {
    report.latencySummaries[key] = summarize(list);
  }

  const totalSeconds = (now() - startedAtMs) / 1000;
  const completedTokens = report.samples
    .filter((sample) => sample.outcome === 'completed')
    .reduce((sum, sample) => sum + (sample.outputTokens ?? 0), 0);
  report.completedTokensPerSecond = totalSeconds > 0 ? completedTokens / totalSeconds : 0;
  if (now() - startedAtMs >= options.durationBudgetMs) report.durationBudgetExceeded = true;
  for (const sample of report.samples) report.outcomeCounts[sample.outcome] += 1;
  report.successful = !report.abortedBeforeRequests && !report.durationBudgetExceeded
    && report.safetyBreaches.length === 0 && report.preflightMismatchReasons.length === 0
    && report.outcomeCounts.completed === report.outcomeCounts.total;

  return report;
}
