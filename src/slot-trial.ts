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

export type TrialWorkload = 'title' | 'fill' | 'portal' | 'isolation';
export type TrialCacheState = 'cold' | 'warm';
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
export interface TrialRequestWirePayload {
  requestIdentifier: string;
  maxOutputTokens: number;
  messages: unknown[];
  tools: unknown[];
}

export interface TrialTransport {
  preflight(): Promise<PreflightInfo>;
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

export type MemorySampler = () => Promise<MemorySample>;

export interface MemoryFloors {
  hostAvailableMebibytesMinimum?: number;
  freshProcessDeviceLocalBudgetMebibytesMinimum?: number;
}

export interface ExpectedToolCall {
  name: string;
  /** Exact-match expected arguments (JSON). When absent, only the call name is checked. */
  arguments?: Record<string, unknown>;
}

export interface TrialRequest {
  requestIdentifier: string;
  workload: TrialWorkload;
  cacheState: TrialCacheState;
  /** Fresh mutable array PER REQUEST — the runner copies it before use; never share one across peers. */
  messages: unknown[];
  tools?: unknown[];
  mocks?: MockMap;
  expectedToolCalls?: ExpectedToolCall[];
  /** Markers belonging to OTHER concurrent requests; any appearance in this response is contamination. */
  foreignMarkers: string[];
  /** This request's own synthetic marker; when set, its absence from the response is flagged. */
  ownMarker?: string;
  maxOutputTokens: number;
  /** Cancel this stream after N non-empty output deltas (cancellation-isolation pairs). */
  cancelAfterDelta?: number;
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
}

export interface SlotTrialOptions {
  transport: TrialTransport;
  profileLabel: string;
  /** Monotonic millisecond clock; defaults to Date.now. Tests inject a fake. */
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
  /** Completed-tool-loop requests only: summed output tokens / total wall seconds. */
  completedTokensPerSecond: number;
  durationBudgetExceeded: boolean;
}

/** The plan's hard bound: more than two requests are never in flight. */
export const MAX_TRIAL_CONCURRENCY = 2;

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

interface RequestRun {
  request: TrialRequest;
  messagesCopy: unknown[];
  toolsCopy: unknown[];
  mocksCopy: MockMap;
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
  if (!floors || !sample) return [];
  const breaches: string[] = [];
  if (floors.hostAvailableMebibytesMinimum !== undefined && sample.hostAvailableMebibytes !== null) {
    if (sample.hostAvailableMebibytes < floors.hostAvailableMebibytesMinimum) {
      breaches.push(
        `${phase}: host available memory ${String(sample.hostAvailableMebibytes)} MiB fell below the ` +
          `${String(floors.hostAvailableMebibytesMinimum)} MiB floor`,
      );
    }
  }
  if (floors.freshProcessDeviceLocalBudgetMebibytesMinimum !== undefined && sample.freshProcessDeviceLocalBudgetMebibytes !== null) {
    if (sample.freshProcessDeviceLocalBudgetMebibytes < floors.freshProcessDeviceLocalBudgetMebibytesMinimum) {
      breaches.push(
        `${phase}: fresh-process device-local budget ${String(sample.freshProcessDeviceLocalBudgetMebibytes)} MiB fell below the ` +
          `${String(floors.freshProcessDeviceLocalBudgetMebibytesMinimum)} MiB floor`,
      );
    }
  }
  return breaches;
}

/**
 * Run the bounded trial. Preflight first — any mismatch aborts before a single
 * completion request. Then requests run through a concurrency-limited pool (max two in
 * flight). Memory floors are checked before launch and after every completion; a breach
 * stops NEW submissions but never kills an in-flight request. The duration budget works
 * the same way. Every request gets its own copy of messages/tools/mocks.
 */
export async function runSlotTrial(options: SlotTrialOptions): Promise<SlotTrialReport> {
  if (options.maxConcurrency > MAX_TRIAL_CONCURRENCY) {
    throw new Error(`slot trial concurrency is bounded at ${MAX_TRIAL_CONCURRENCY} (got ${String(options.maxConcurrency)})`);
  }
  const now = options.now ?? ((): number => Date.now());
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
  };

  const preflight = await options.transport.preflight();
  report.preflight = preflight;
  report.preflightMismatchReasons = checkPreflight(options, preflight);
  if (report.preflightMismatchReasons.length > 0) {
    report.abortedBeforeRequests = true;
    for (const request of options.requests) {
      report.samples.push({ ...newSample(options.profileLabel), requestIdentifier: request.requestIdentifier, workload: request.workload, cacheState: request.cacheState });
    }
    return report;
  }

  // Abort before any request when the pre-run gate itself is already breached.
  const initialSample = options.memorySampler ? await options.memorySampler() : null;
  if (initialSample) report.memorySamples.push(initialSample);
  const initialBreaches = floorBreaches(initialSample, options.memoryFloors, 'pre-run');
  if (initialBreaches.length > 0) {
    report.safetyBreaches.push(...initialBreaches);
    for (const request of options.requests) {
      report.samples.push({ ...newSample(options.profileLabel), requestIdentifier: request.requestIdentifier, workload: request.workload, cacheState: request.cacheState });
    }
    return report;
  }

  const startedAtMs = now();
  let halted = false; // a mid-run floor breach stops new submissions

  const queue = [...options.requests];
  const inFlight = new Set<Promise<void>>();

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
    };
    // Shallow copy only: MockMap values are functions and JSON would silently drop them.
    const mocks: MockMap = { ...(request.mocks ?? {}) };

    sample.startedAtMilliseconds = now();
    const controller = new AbortController();
    let nonEmptyDeltas = 0;
    let lastDeltaAt: number | null = null;
    let maxGap: number | null = null;
    let firstDeltaAt: number | null = null;

    const noteDelta = (channel: TrialChannel, text: string): void => {
      if (text.length === 0) return;
      seenTextParts.push(text);
      const at = now();
      if (channel === 'content') sample.sawContentDelta = true;
      if (channel === 'tool_arguments') sample.sawToolArgumentsDelta = true;
      if (channel === 'reasoning') sample.sawReasoningDelta = true;
      if (firstDeltaAt === null) firstDeltaAt = at;
      if (lastDeltaAt !== null) maxGap = Math.max(maxGap ?? 0, at - lastDeltaAt);
      lastDeltaAt = at;
      nonEmptyDeltas += 1;
      if (request.cancelAfterDelta !== undefined && nonEmptyDeltas >= request.cancelAfterDelta) {
        controller.abort();
      }
    };

    // Tool-call fragments keyed by index, reconstructed at stream end.
    const fragments = new Map<number, { id: string | null; name: string | null; argumentsParts: string[] }>();
    // All received response text (content + reasoning + tool arguments), for marker checks.
    const seenTextParts: string[] = [];
    let streamFailed = false;

    try {
      const stream = await options.transport.stream(payload, controller.signal);
      sample.responseStatus = stream.status;
      if (stream.status !== null && stream.status >= 400) {
        streamFailed = true;
        sample.validationErrors.push(`streaming request failed with HTTP ${String(stream.status)}`);
      } else {
        for await (const chunk of stream.chunks) {
          if (controller.signal.aborted) break;
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content) noteDelta('content', delta.content);
          if (delta?.reasoning_content) noteDelta('reasoning', delta.reasoning_content);
          for (const call of delta?.tool_calls ?? []) {
            if (!call) continue;
            const index = call.index ?? 0;
            const entry = fragments.get(index) ?? { id: null, name: null, argumentsParts: [] };
            if (call.id) entry.id = call.id;
            if (call.function?.name) entry.name = call.function.name;
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
      }
    } catch (error) {
      streamFailed = true;
      sample.validationErrors.push(`stream error: ${String(error instanceof Error ? error.message : error)}`);
    }

    sample.firstOutputDeltaMilliseconds = firstDeltaAt;
    sample.completedAtMilliseconds = now();
    sample.maximumOutputDeltaGapMilliseconds = maxGap;

    if (controller.signal.aborted) {
      // Cancelled neighbour: the slot is released by the server on abort; nothing to flag
      // as long as the stream ended because of OUR cancellation.
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
          parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
          mockResult = parseMockResult(runTool(entry.name ?? '', parsed, mocks));
        } catch {
          // HTTP success is not tool correctness: an unparseable reconstruction fails the request.
          sample.validationErrors.push(`malformed (unparseable) reconstructed tool-call arguments for '${entry.name ?? 'unknown'}'`);
          sample.outcome = 'failed';
        }
        sample.reconstructedToolCalls.push({ index, id: entry.id, name: entry.name, argumentsJson, arguments: parsed, mockResult });
      }
    }

    // Validation: expected tool calls.
    if (request.expectedToolCalls && sample.outcome !== 'cancelled') {
      const reconstructed = sample.reconstructedToolCalls ?? [];
      for (const expected of request.expectedToolCalls) {
        const match = reconstructed.find(
          (call) => call.name === expected.name && (expected.arguments === undefined || jsonEqual(call.arguments, expected.arguments)),
        );
        if (!match) {
          sample.validationErrors.push(`expected tool call '${expected.name}'${expected.arguments ? ' with the expected arguments' : ''} never arrived`);
        }
      }
    }

    // Validation: markers over all text this request actually received.
    const seenText = seenTextParts.join('');
    for (const marker of request.foreignMarkers) {
      if (seenText.includes(marker)) sample.foreignMarkers.push(marker);
    }
    if (request.ownMarker !== undefined && !seenText.includes(request.ownMarker)) {
      sample.validationErrors.push(`own marker '${request.ownMarker}' did not appear in the response content`);
    }

    // Validation: warm/cold labelling vs observed cache usage (only when usage was supplied).
    if (sample.cachedInputTokens !== null && request.cacheState === 'cold' && sample.cachedInputTokens > 0) {
      sample.validationErrors.push(`request labelled cold reported ${String(sample.cachedInputTokens)} cached input tokens (label mismatch)`);
    }

    // Safety gate after every completion: stop NEW submissions on a breach.
    if (options.memorySampler) {
      const memorySample = await options.memorySampler();
      report.memorySamples.push(memorySample);
      const breaches = floorBreaches(memorySample, options.memoryFloors, 'runtime');
      if (breaches.length > 0) {
        report.safetyBreaches.push(...breaches);
        halted = true;
      }
    }
  }

  // Pool loop: launch up to maxConcurrency; before each launch honour the halt and budget.
  while (queue.length > 0 || inFlight.size > 0) {
    while (queue.length > 0 && inFlight.size < options.maxConcurrency) {
      if (halted || now() - startedAtMs > options.durationBudgetMs) {
        report.durationBudgetExceeded = report.durationBudgetExceeded || (now() - startedAtMs > options.durationBudgetMs);
        for (const pending of queue.splice(0, queue.length)) {
          report.samples.push({ ...newSample(options.profileLabel), requestIdentifier: pending.requestIdentifier, workload: pending.workload, cacheState: pending.cacheState });
        }
        break;
      }
      const next = queue.shift() as TrialRequest;
      void launch(next);
    }
    if (inFlight.size === 0) break;
    await Promise.race(inFlight);
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

  return report;
}
