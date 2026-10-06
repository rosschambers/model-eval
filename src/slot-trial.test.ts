// Offline tests for the Qwen3.5-4B two-slot trial runner. NOTHING here touches
// frame, OpenRouter, murmur8, n8n or real tools: transport, clock and memory
// sampler are injected fakes; scripted streams replay delta sequences with
// exact timing so every timing, attribution and safety assertion is
// deterministic. Timing convention: event times in a script are offsets from
// that request's own start (the first event lands at 0, gap 0), so per-request
// timings are exact regardless of when the runner launches the stream.

import { describe, it, expect } from 'vitest';
import { runSlotTrial } from './slot-trial.js';
import type { PreflightInfo, SlotTrialReport, SlotTrialSample, TrialRequestWirePayload, TrialStreamChunk, TrialTransport } from './slot-trial.js';
import type { MockMap } from './mock-engine.js';

// ---------------------------------------------------------------------------
// Scripted transport helpers
// ---------------------------------------------------------------------------

type ScriptChannel = 'content' | 'reasoning' | 'tool_arguments';

interface ScriptEvent {
  atMs: number; // absolute ms on the trial clock since trial start
  channel?: ScriptChannel;
  text?: string;
  toolCallIndex?: number;
  toolCallId?: string;
  toolName?: string;
  finishReason?: string | null;
  usage?: {
    promptTokens?: number | null;
    cachedInputTokens?: number | null;
    outputTokens?: number | null;
  } | null;
}

interface ScriptedRequest {
  requestIdentifier: string;
  events: ScriptEvent[];
  errorAtMs?: number; // stream raises an error this many ms after the stream starts
  status?: number; // HTTP status reported for the stream (default 200)
}

interface ScriptedServer {
  preflight: PreflightInfo;
  requests: ScriptedRequest[];
}

function chunkFromEvent(event: ScriptEvent): TrialStreamChunk {
  const choice: NonNullable<NonNullable<TrialStreamChunk['choices']>[number]> = {};
  if (event.finishReason !== undefined) choice.finish_reason = event.finishReason;
  if (event.channel === 'content') choice.delta = { content: event.text ?? '' };
  else if (event.channel === 'reasoning') choice.delta = { reasoning_content: event.text ?? '' };
  else if (event.channel === 'tool_arguments') {
    choice.delta = {
      tool_calls: [
        {
          index: event.toolCallIndex ?? 0,
          ...(event.toolCallId !== undefined ? { id: event.toolCallId } : {}),
          ...(event.toolName !== undefined ? { function: { name: event.toolName } } : {}),
          ...(event.text !== undefined ? { function: { name: event.toolName ?? '', arguments: event.text } } : {}),
        },
      ],
    };
  }
  const chunk: TrialStreamChunk = { choices: [choice] };
  // Script events use camelCase for readability; the wire shape (and the runner's
  // reader) is the OpenAI streaming schema in snake_case.
  if (event.usage) {
    chunk.usage = {
      prompt_tokens: event.usage.promptTokens ?? null,
      completion_tokens: event.usage.outputTokens ?? null,
      prompt_tokens_details: { cached_tokens: event.usage.cachedInputTokens ?? null },
    };
  }
  return chunk;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A fake transport serving scripted streams on the real clock. Event times are
 * offsets from each stream's own start; cancellation stops the stream at the
 * cancel moment (the server sees the abort and releases the slot).
 */
function makeTransportWithClock(server: ScriptedServer) {
  const startedIdentifiers: string[] = [];
  const transport: TrialTransport & { streamWasStartedFor(id: string): boolean } = {
    async preflight(): Promise<PreflightInfo> {
      return server.preflight;
    },
    async stream(request: TrialRequestWirePayload, signal: AbortSignal) {
      startedIdentifiers.push(request.requestIdentifier);
      const script = server.requests.find((entry) => entry.requestIdentifier === request.requestIdentifier);
      if (!script) throw new Error(`no script for request ${request.requestIdentifier}`);
      // The runner must hand over fresh mutable arrays per request (acceptance 6):
      // mutate the inputs to prove nothing is shared across peers.
      request.messages.push({ role: 'user', content: `[server echo] ${request.requestIdentifier}` });
      const events = [...script.events].sort((a, b) => a.atMs - b.atMs);
      const streamStart = Date.now();
      return {
        status: script.status ?? 200,
        chunks: {
          async *[Symbol.asyncIterator]() {
            for (const event of events) {
              if (signal.aborted) return;
              const waitUntil = streamStart + event.atMs;
              const remaining = waitUntil - Date.now();
              if (remaining > 0) await sleep(remaining);
              if (signal.aborted) return;
              yield chunkFromEvent(event);
            }
            if (script.errorAtMs !== undefined) {
              const remaining = script.errorAtMs - (Date.now() - streamStart);
              if (remaining > 0) await sleep(remaining);
              if (signal.aborted) return;
              throw new Error('stream error');
            }
          },
        },
      };
    },
    streamWasStartedFor(id: string): boolean {
      return startedIdentifiers.includes(id);
    },
  };
  return transport;
}

function sampleById(report: SlotTrialReport, id: string): SlotTrialSample {
  const found = report.samples.find((sample) => sample.requestIdentifier === id);
  if (!found) throw new Error(`no sample for ${id}`);
  return found;
}

// ---------------------------------------------------------------------------

describe('slot trial runner', () => {
  it('attributes samples by explicit request identifier, not completion order', async () => {
    const transport = makeTransportWithClock({
      preflight: { slots: 2, contextPerSlot: 24576, modelPath: 'Qwen_Qwen3.5-4B-Q5_K_M-bartowski.gguf', attentionCacheType: 'f16', kvUnified: false },
      requests: [
        {
          requestIdentifier: 'slow-one',
          events: [
            { atMs: 0, channel: 'content', text: 'tick ' },
            { atMs: 400, channel: 'content', text: 'tock' },
            { atMs: 500, finishReason: 'stop', usage: { promptTokens: 900, cachedInputTokens: 800, outputTokens: 12 } },
          ],
        },
        {
          requestIdentifier: 'fast-two',
          events: [
            { atMs: 0, channel: 'content', text: 'quick' },
            { atMs: 60, finishReason: 'stop', usage: { promptTokens: 100, cachedInputTokens: 0, outputTokens: 3 } },
          ],
        },
      ],
    });

    const report = await runSlotTrial({
      transport,
      profileLabel: 'P3',
      expectedSlots: 2,
      expectedContextPerSlot: 24576,
      maxConcurrency: 2,
      maxRequests: 10,
      durationBudgetMs: 10_000,
      requests: [
        { requestIdentifier: 'slow-one', workload: 'portal', cacheState: 'warm', messages: [], mocks: {}, foreignMarkers: ['FAST_TWO'], maxOutputTokens: 64 },
        { requestIdentifier: 'fast-two', workload: 'title', cacheState: 'cold', messages: [], mocks: {}, foreignMarkers: ['SLOW_ONE'], maxOutputTokens: 16 },
      ],
    });

    const slow = sampleById(report, 'slow-one');
    const fast = sampleById(report, 'fast-two');
    // Completion order was reversed relative to request order; attribution must
    // follow the identifier. (Both launch in the same millisecond — same ms clock.)
    expect(slow.startedAtMilliseconds!).toBeLessThanOrEqual(fast.startedAtMilliseconds!);
    expect(slow.completedAtMilliseconds!).toBeGreaterThan(fast.completedAtMilliseconds!);
    expect(slow.workload).toBe('portal');
    expect(fast.workload).toBe('title');
    expect(slow.outputTokens).toBe(12);
    expect(fast.outputTokens).toBe(3);
    // fast-two started at ~t0 and finished at ~60ms; slow-one at ~500ms.
    expect(fast.completedAtMilliseconds! - fast.startedAtMilliseconds!).toBeLessThan(150);
    expect(slow.completedAtMilliseconds! - slow.startedAtMilliseconds!).toBeGreaterThanOrEqual(450);
  }, 10_000);

  it('reconstructs fragmented content and tool-call deltas and records delta-level timings', async () => {
    const transport = makeTransportWithClock({
      preflight: { slots: 2, contextPerSlot: 24576, modelPath: 'Qwen_Qwen3.5-4B-Q5_K_M-bartowski.gguf', attentionCacheType: 'f16', kvUnified: false },
      requests: [
        {
          requestIdentifier: 'frag-one',
          events: [
            { atMs: 0, channel: 'reasoning', text: 'thinking' },
            { atMs: 40, channel: 'content', text: 'Hel' },
            { atMs: 120, channel: 'content', text: 'lo ' },
            { atMs: 320, channel: 'content', text: 'world' },
            { atMs: 340, channel: 'tool_arguments', toolCallIndex: 0, toolCallId: 'call-1', toolName: 'list' },
            { atMs: 360, channel: 'tool_arguments', toolCallIndex: 0, text: '{"ty' },
            { atMs: 380, channel: 'tool_arguments', toolCallIndex: 0, text: 'pe":"tas' },
            { atMs: 400, channel: 'tool_arguments', toolCallIndex: 0, text: 'ks"}' },
            { atMs: 420, finishReason: 'tool_calls', usage: { promptTokens: 50, cachedInputTokens: 0, outputTokens: 20 } },
          ],
        },
      ],
    });

    const mocks: MockMap = { list: (args: any) => ({ receivedType: args.type }) };

    const report = await runSlotTrial({
      transport,
      profileLabel: 'P3',
      expectedSlots: 2,
      expectedContextPerSlot: 24576,
      maxConcurrency: 2,
      maxRequests: 10,
      durationBudgetMs: 10_000,
      requests: [
        {
          requestIdentifier: 'frag-one',
          workload: 'fill',
          cacheState: 'cold',
          messages: [],
          mocks,
          foreignMarkers: [],
          maxOutputTokens: 64,
          expectedToolCalls: [{ name: 'list', arguments: { type: 'tasks' } }],
        },
      ],
    });

    const sample = sampleById(report, 'frag-one');
    expect(sample.outcome).toBe('completed');
    // First NON-EMPTY output delta is the reasoning delta landing at stream start.
    expect(Math.abs(sample.firstOutputDeltaMilliseconds! - sample.startedAtMilliseconds!)).toBeLessThan(50);
    // Largest gap between consecutive output events is 320-120 = 200ms (timer jitter tolerance).
    expect(sample.maximumOutputDeltaGapMilliseconds!).toBeGreaterThanOrEqual(200);
    expect(sample.maximumOutputDeltaGapMilliseconds!).toBeLessThan(260);
    // The reconstructed tool call must be handed to the mock engine whole and parse:
    expect(sample.validationErrors).toEqual([]);
    expect(sample.reconstructedToolCalls).toMatchObject([{ name: 'list', arguments: { type: 'tasks' }, mockResult: { receivedType: 'tasks' } }]);
  }, 10_000);

  it('flags a cold-labelled request that reports cache hits (label mismatch)', async () => {
    const transport = makeTransportWithClock({
      preflight: { slots: 2, contextPerSlot: 24576, modelPath: 'x.gguf', attentionCacheType: 'f16', kvUnified: false },
      requests: [
        { requestIdentifier: 'cold-but-warm', events: [{ atMs: 0, channel: 'content', text: 'ok' }, { atMs: 50, finishReason: 'stop', usage: { promptTokens: 100, cachedInputTokens: 64, outputTokens: 2 } }] },
      ],
    });

    const report = await runSlotTrial({
      transport,
      profileLabel: 'P3',
      expectedSlots: 2,
      expectedContextPerSlot: 24576,
      maxConcurrency: 2,
      maxRequests: 10,
      durationBudgetMs: 5_000,
      requests: [{ requestIdentifier: 'cold-but-warm', workload: 'title', cacheState: 'cold', messages: [], mocks: {}, foreignMarkers: [], maxOutputTokens: 16 }],
    });

    expect(report.samples[0].validationErrors.join(' ')).toMatch(/cold/i);
    expect(report.safetyBreaches).toEqual([]); // label mismatch is a validation error, not a safety breach
  });

  it('marks a cancelled neighbour as cancelled while its pair completes normally', async () => {
    const transport = makeTransportWithClock({
      preflight: { slots: 2, contextPerSlot: 24576, modelPath: 'x.gguf', attentionCacheType: 'f16', kvUnified: false },
      requests: [
        { requestIdentifier: 'long-one', events: [{ atMs: 0, channel: 'content', text: 'a' }, { atMs: 200, channel: 'content', text: 'b' }, { atMs: 400, channel: 'content', text: 'c' }, { atMs: 600, finishReason: 'stop', usage: { promptTokens: 500, cachedInputTokens: 0, outputTokens: 30 } }] },
        { requestIdentifier: 'doomed-one', events: [{ atMs: 0, channel: 'content', text: 'x' }, { atMs: 100, channel: 'content', text: 'y' }, { atMs: 900, finishReason: 'stop', usage: { promptTokens: 500, cachedInputTokens: 0, outputTokens: 30 } }] },
      ],
    });

    const report = await runSlotTrial({
      transport,
      profileLabel: 'P3',
      expectedSlots: 2,
      expectedContextPerSlot: 24576,
      maxConcurrency: 2,
      maxRequests: 10,
      durationBudgetMs: 5_000,
      requests: [
        { requestIdentifier: 'long-one', workload: 'portal', cacheState: 'cold', messages: [], mocks: {}, foreignMarkers: [], maxOutputTokens: 64 },
        { requestIdentifier: 'doomed-one', workload: 'isolation', cacheState: 'cold', messages: [], mocks: {}, foreignMarkers: [], maxOutputTokens: 64, cancelAfterDelta: 1 },
      ],
    });

    const cancelled = sampleById(report, 'doomed-one');
    const completed = sampleById(report, 'long-one');
    expect(cancelled.outcome).toBe('cancelled');
    expect(cancelled.validationErrors).toEqual([]);
    expect(completed.outcome).toBe('completed');
    expect(completed.validationErrors).toEqual([]);
  }, 10_000);

  it('records null token counts when the server supplies no usage block', async () => {
    const transport = makeTransportWithClock({
      preflight: { slots: 2, contextPerSlot: 24576, modelPath: 'x.gguf', attentionCacheType: 'f16', kvUnified: false },
      requests: [{ requestIdentifier: 'no-usage', events: [{ atMs: 0, channel: 'content', text: 'ok' }, { atMs: 100, finishReason: 'stop' }] }],
    });

    const report = await runSlotTrial({
      transport,
      profileLabel: 'P3',
      expectedSlots: 2,
      expectedContextPerSlot: 24576,
      maxConcurrency: 2,
      maxRequests: 10,
      durationBudgetMs: 5_000,
      requests: [{ requestIdentifier: 'no-usage', workload: 'title', cacheState: 'cold', messages: [], mocks: {}, foreignMarkers: [], maxOutputTokens: 16 }],
    });

    const sample = report.samples[0];
    expect(sample.inputTokens).toBeNull();
    expect(sample.cachedInputTokens).toBeNull();
    expect(sample.outputTokens).toBeNull();
    expect(sample.outcome).toBe('completed'); // content was received; only the usage block is missing
  });

  it('stops submitting new work when a memory floor is breached, without killing in-flight requests', async () => {
    // Sampler readings: start at 3000 MiB (above both floors), drop below the GPU
    // floor (2098.25) after 'gate-breaker' starts — 'never-started' must never launch.
    const readings: number[] = [3000, 1900];
    let readingIndex = 0;
    const transport = makeTransportWithClock({
      preflight: { slots: 2, contextPerSlot: 24576, modelPath: 'x.gguf', attentionCacheType: 'f16', kvUnified: false },
      requests: [
        { requestIdentifier: 'gate-breaker', events: [{ atMs: 0, channel: 'content', text: 'a' }, { atMs: 300, finishReason: 'stop', usage: { promptTokens: 10, cachedInputTokens: 0, outputTokens: 5 } }] },
        { requestIdentifier: 'never-started', events: [{ atMs: 0, channel: 'content', text: 'b' }, { atMs: 100, finishReason: 'stop' }] },
      ],
    });

    const report = await runSlotTrial({
      transport,
      profileLabel: 'P3',
      expectedSlots: 2,
      expectedContextPerSlot: 24576,
      maxConcurrency: 1, // the gated request must not already be in flight when the floor is crossed
      maxRequests: 10,
      durationBudgetMs: 5_000,
      memoryFloors: { hostAvailableMebibytesMinimum: 2048, freshProcessDeviceLocalBudgetMebibytesMinimum: 2098.25 },
      memorySampler: async () => ({
        takenAtMilliseconds: Date.now(),
        hostAvailableMebibytes: 3000,
        freshProcessDeviceLocalBudgetMebibytes: readings[Math.min(readingIndex++, readings.length - 1)],
      }),
      requests: [
        { requestIdentifier: 'gate-breaker', workload: 'portal', cacheState: 'cold', messages: [], mocks: {}, foreignMarkers: [], maxOutputTokens: 64 },
        { requestIdentifier: 'never-started', workload: 'title', cacheState: 'cold', messages: [], mocks: {}, foreignMarkers: [], maxOutputTokens: 16 },
      ],
    });

    expect(report.safetyBreaches.length).toBeGreaterThan(0);
    expect(report.memorySamples.length).toBeGreaterThanOrEqual(2);
    const never = report.samples.find((sample) => sample.requestIdentifier === 'never-started');
    expect(never?.outcome).toBe('not_started');
    expect(transport.streamWasStartedFor('never-started')).toBe(false);
    expect(sampleById(report, 'gate-breaker').outcome).toBe('completed'); // in-flight work was not killed
  });

  it('flags foreign synthetic markers appearing in a response', async () => {
    const transport = makeTransportWithClock({
      preflight: { slots: 2, contextPerSlot: 24576, modelPath: 'x.gguf', attentionCacheType: 'f16', kvUnified: false },
      requests: [{ requestIdentifier: 'leaky', events: [{ atMs: 0, channel: 'content', text: 'MARKER_SLOWONE leaked through' }, { atMs: 100, finishReason: 'stop' }] }],
    });

    const report = await runSlotTrial({
      transport,
      profileLabel: 'P3',
      expectedSlots: 2,
      expectedContextPerSlot: 24576,
      maxConcurrency: 2,
      maxRequests: 10,
      durationBudgetMs: 5_000,
      requests: [{ requestIdentifier: 'leaky', workload: 'portal', cacheState: 'cold', messages: [], mocks: {}, foreignMarkers: ['MARKER_SLOWONE', 'MARKER_FASTTWO'], ownMarker: 'MARKER_LEAKY', maxOutputTokens: 64 }],
    });

    const sample = report.samples[0];
    expect(sample.foreignMarkers).toEqual(['MARKER_SLOWONE']);
    // Own marker expected but absent — flagged too (a response that lost its own
    // identity is as bad as one that gained someone else's).
    expect(sample.validationErrors.join(' ')).toMatch(/own marker/i);
  });

  it('aborts before any completion request when preflight reports one slot but two were requested', async () => {
    const transport = makeTransportWithClock({
      preflight: { slots: 1, contextPerSlot: 24576, modelPath: 'x.gguf', attentionCacheType: 'f16', kvUnified: false },
      requests: [{ requestIdentifier: 'never-runs', events: [{ atMs: 0, channel: 'content', text: 'nope' }] }],
    });

    const report = await runSlotTrial({
      transport,
      profileLabel: 'P3',
      expectedSlots: 2,
      expectedContextPerSlot: 24576,
      expectedModelPath: 'x.gguf',
      expectedAttentionCacheType: 'f16',
      expectedKvUnified: false,
      maxConcurrency: 2,
      maxRequests: 10,
      durationBudgetMs: 5_000,
      requests: [{ requestIdentifier: 'never-runs', workload: 'title', cacheState: 'cold', messages: [], mocks: {}, foreignMarkers: [], maxOutputTokens: 16 }],
    });

    expect(report.abortedBeforeRequests).toBe(true);
    expect(report.preflightMismatchReasons.join(' ')).toMatch(/slot/i);
    expect(transport.streamWasStartedFor('never-runs')).toBe(false);
    // Aborted requests are recorded as not_started with no timings — nothing ran.
    expect(report.samples.length).toBe(1);
    expect(report.samples[0].outcome).toBe('not_started');
    expect(report.samples[0].startedAtMilliseconds).toBeNull();
  });

  it('treats an empty stream as a failure, not a success', async () => {
    const transport = makeTransportWithClock({
      preflight: { slots: 2, contextPerSlot: 24576, modelPath: 'x.gguf', attentionCacheType: 'f16', kvUnified: false },
      requests: [{ requestIdentifier: 'empty-stream', events: [] }],
    });

    const report = await runSlotTrial({
      transport,
      profileLabel: 'P3',
      expectedSlots: 2,
      expectedContextPerSlot: 24576,
      maxConcurrency: 2,
      maxRequests: 10,
      durationBudgetMs: 5_000,
      requests: [{ requestIdentifier: 'empty-stream', workload: 'title', cacheState: 'cold', messages: [], mocks: {}, foreignMarkers: [], maxOutputTokens: 16 }],
    });

    const sample = report.samples[0];
    expect(sample.outcome).toBe('failed');
    expect(sample.validationErrors.join(' ')).toMatch(/empty/i);
  });

  it('refuses a concurrency cap above two', async () => {
    const transport = makeTransportWithClock({ preflight: { slots: 2, contextPerSlot: 24576, modelPath: 'x.gguf', attentionCacheType: 'f16', kvUnified: false }, requests: [] });
    await expect(
      runSlotTrial({
        transport,
        profileLabel: 'P3',
        expectedSlots: 2,
        expectedContextPerSlot: 24576,
        maxConcurrency: 3,
        maxRequests: 10,
        durationBudgetMs: 5_000,
        requests: [],
      }),
    ).rejects.toThrow(/concurren/i);
  });

  it('never shares one mutable messages array or mock map across peers', async () => {
    // Both requests are handed THE SAME array and mock object references. The
    // runner must copy per request, so server-side mutation echoes cannot leak.
    const sharedMessages: unknown[] = [{ role: 'user', content: 'shared' }];
    const sharedMocks: MockMap = {
      list: (args: any) => ({ echoOfArgsType: args.type }),
    };
    const transport = makeTransportWithClock({
      preflight: { slots: 2, contextPerSlot: 24576, modelPath: 'x.gguf', attentionCacheType: 'f16', kvUnified: false },
      requests: [
        { requestIdentifier: 'peer-a', events: [{ atMs: 0, channel: 'tool_arguments', toolCallIndex: 0, toolCallId: 'a1', toolName: 'list' }, { atMs: 20, channel: 'tool_arguments', toolCallIndex: 0, text: '{"type":"tasks"}' }, { atMs: 60, finishReason: 'tool_calls' }] },
        { requestIdentifier: 'peer-b', events: [{ atMs: 0, channel: 'tool_arguments', toolCallIndex: 0, toolCallId: 'b1', toolName: 'list' }, { atMs: 30, channel: 'tool_arguments', toolCallIndex: 0, text: '{"type":"calendars"}' }, { atMs: 80, finishReason: 'tool_calls' }] },
      ],
    });

    const report = await runSlotTrial({
      transport,
      profileLabel: 'P3',
      expectedSlots: 2,
      expectedContextPerSlot: 24576,
      maxConcurrency: 2,
      maxRequests: 10,
      durationBudgetMs: 5_000,
      requests: [
        { requestIdentifier: 'peer-a', workload: 'fill', cacheState: 'cold', messages: sharedMessages, mocks: sharedMocks, foreignMarkers: [], maxOutputTokens: 32 },
        { requestIdentifier: 'peer-b', workload: 'fill', cacheState: 'cold', messages: sharedMessages, mocks: sharedMocks, foreignMarkers: [], maxOutputTokens: 32 },
      ],
    });

    // Each peer's tool loop must see only its own call (the mock echoes its args back).
    const a = sampleById(report, 'peer-a');
    const b = sampleById(report, 'peer-b');
    expect(a.reconstructedToolCalls?.[0].mockResult).toEqual({ echoOfArgsType: 'tasks' });
    expect(b.reconstructedToolCalls?.[0].mockResult).toEqual({ echoOfArgsType: 'calendars' });
    // The caller's own array must not have grown from one peer's conversation.
    expect(sharedMessages.length).toBe(1);
  }, 10_000);

  it('records an expected tool call that never arrived as a validation error', async () => {
    const transport = makeTransportWithClock({
      preflight: { slots: 2, contextPerSlot: 24576, modelPath: 'x.gguf', attentionCacheType: 'f16', kvUnified: false },
      requests: [{ requestIdentifier: 'lazy', events: [{ atMs: 0, channel: 'content', text: 'done' }, { atMs: 50, finishReason: 'stop' }] }],
    });

    const report = await runSlotTrial({
      transport,
      profileLabel: 'P3',
      expectedSlots: 2,
      expectedContextPerSlot: 24576,
      maxConcurrency: 2,
      maxRequests: 10,
      durationBudgetMs: 5_000,
      requests: [{ requestIdentifier: 'lazy', workload: 'fill', cacheState: 'cold', messages: [], mocks: {}, foreignMarkers: [], maxOutputTokens: 16, expectedToolCalls: [{ name: 'list', arguments: { type: 'tasks' } }] }],
    });

    expect(report.samples[0].validationErrors.join(' ')).toMatch(/tool/i);
  });

  it('flags a malformed reconstructed tool call instead of answering it', async () => {
    const transport = makeTransportWithClock({
      preflight: { slots: 2, contextPerSlot: 24576, modelPath: 'x.gguf', attentionCacheType: 'f16', kvUnified: false },
      requests: [
        {
          requestIdentifier: 'malformed',
          events: [
            { atMs: 0, channel: 'tool_arguments', toolCallIndex: 0, toolCallId: 'c1', toolName: 'list' },
            { atMs: 20, channel: 'tool_arguments', toolCallIndex: 0, text: '{"type": "tasks"' }, // missing close brace
            { atMs: 60, finishReason: 'tool_calls' },
          ],
        },
      ],
    });

    const report = await runSlotTrial({
      transport,
      profileLabel: 'P3',
      expectedSlots: 2,
      expectedContextPerSlot: 24576,
      maxConcurrency: 2,
      maxRequests: 10,
      durationBudgetMs: 5_000,
      requests: [{ requestIdentifier: 'malformed', workload: 'fill', cacheState: 'cold', messages: [], mocks: {}, foreignMarkers: [], maxOutputTokens: 16 }],
    });

    const sample = report.samples[0];
    expect(sample.outcome).toBe('failed'); // HTTP stream ended, but the tool call did not reconstruct
    expect(sample.validationErrors.join(' ')).toMatch(/malformed|unparseable/i);
    expect(sample.reconstructedToolCalls?.[0].mockResult ?? null).toBeNull();
  });

  it('summarizes completion latency through the shared nearest-rank summarizer', async () => {
    const transport = makeTransportWithClock({
      preflight: { slots: 2, contextPerSlot: 24576, modelPath: 'x.gguf', attentionCacheType: 'f16', kvUnified: false },
      requests: [
        { requestIdentifier: 's1', events: [{ atMs: 0, channel: 'content', text: 'a' }, { atMs: 100, finishReason: 'stop', usage: { outputTokens: 5 } }] },
        { requestIdentifier: 's2', events: [{ atMs: 0, channel: 'content', text: 'b' }, { atMs: 300, finishReason: 'stop', usage: { outputTokens: 5 } }] },
        { requestIdentifier: 's3', events: [{ atMs: 0, channel: 'content', text: 'c' }, { atMs: 200, finishReason: 'stop', usage: { outputTokens: 5 } }] },
      ],
    });

    const report = await runSlotTrial({
      transport,
      profileLabel: 'P3',
      expectedSlots: 2,
      expectedContextPerSlot: 24576,
      maxConcurrency: 1, // serialize so timings are exact despite real-clock jitter
      maxRequests: 10,
      durationBudgetMs: 5_000,
      requests: [100, 300, 200].map((ms, index) => ({
        requestIdentifier: `s${index + 1}`,
        workload: 'title' as const,
        cacheState: 'cold' as const,
        messages: [],
        mocks: {} as MockMap,
        foreignMarkers: [],
        maxOutputTokens: 16,
      })),
    });

    const summary = report.latencySummaries['title|cold'];
    expect(summary.samples).toBe(3);
    // Nearest-rank p95 over {100,200,300} at n=3 is the max; timing tolerance ±75ms.
    expect(summary.median).toBeGreaterThanOrEqual(Math.max(0, 200 - 75));
    expect(summary.median).toBeLessThanOrEqual(200 + 75);
    expect(summary.p95).toBeGreaterThanOrEqual(Math.max(0, 300 - 75));
    expect(summary.p95).toBeLessThanOrEqual(300 + 75);
    expect(report.completedTokensPerSecond).toBeGreaterThan(0);
  }, 10_000);

  it('records an HTTP error status and stream errors as failures', async () => {
    const transport = makeTransportWithClock({
      preflight: { slots: 2, contextPerSlot: 24576, modelPath: 'x.gguf', attentionCacheType: 'f16', kvUnified: false },
      requests: [{ requestIdentifier: 'errored', status: 503, events: [], errorAtMs: 80 }],
    });

    const report = await runSlotTrial({
      transport,
      profileLabel: 'P3',
      expectedSlots: 2,
      expectedContextPerSlot: 24576,
      maxConcurrency: 2,
      maxRequests: 10,
      durationBudgetMs: 5_000,
      requests: [{ requestIdentifier: 'errored', workload: 'portal', cacheState: 'cold', messages: [], mocks: {}, foreignMarkers: [], maxOutputTokens: 16 }],
    });

    const sample = report.samples[0];
    expect(sample.outcome).toBe('failed');
    expect(sample.responseStatus).toBe(503);
    expect(sample.validationErrors.join(' ')).toMatch(/error|fail/i);
  });

  it('aborts the run when the duration budget is exceeded, keeping completed samples', async () => {
    const transport = makeTransportWithClock({
      preflight: { slots: 2, contextPerSlot: 24576, modelPath: 'x.gguf', attentionCacheType: 'f16', kvUnified: false },
      requests: [
        { requestIdentifier: 'slow-block', events: [{ atMs: 0, channel: 'content', text: 'a' }, { atMs: 400, finishReason: 'stop' }] },
        { requestIdentifier: 'post-budget', events: [{ atMs: 0, channel: 'content', text: 'b' }, { atMs: 100, finishReason: 'stop' }] },
      ],
    });

    const report = await runSlotTrial({
      transport,
      profileLabel: 'P3',
      expectedSlots: 2,
      expectedContextPerSlot: 24576,
      maxConcurrency: 1,
      maxRequests: 10,
      durationBudgetMs: 350, // budget blows past during slow-block's 400ms run + next launch
      requests: [
        { requestIdentifier: 'slow-block', workload: 'portal', cacheState: 'cold', messages: [], mocks: {}, foreignMarkers: [], maxOutputTokens: 16 },
        { requestIdentifier: 'post-budget', workload: 'title', cacheState: 'cold', messages: [], mocks: {}, foreignMarkers: [], maxOutputTokens: 16 },
      ],
    });

    expect(report.durationBudgetExceeded).toBe(true);
    expect(sampleById(report, 'slow-block').outcome).toBe('completed');
    expect(sampleById(report, 'post-budget').outcome).toBe('not_started');
    expect(transport.streamWasStartedFor('post-budget')).toBe(false);
  }, 10_000);

  it('records the memory floor gate crossing at trial start and samples during the run', async () => {
    const readings = [4200, 4050];
    let readingIndex = 0;
    const transport = makeTransportWithClock({
      preflight: { slots: 2, contextPerSlot: 24576, modelPath: 'x.gguf', attentionCacheType: 'f16', kvUnified: false },
      requests: [{ requestIdentifier: 'solo', events: [{ atMs: 0, channel: 'content', text: 'ok' }, { atMs: 150, finishReason: 'stop' }] }],
    });

    const report = await runSlotTrial({
      transport,
      profileLabel: 'P3',
      expectedSlots: 2,
      expectedContextPerSlot: 24576,
      maxConcurrency: 2,
      maxRequests: 10,
      durationBudgetMs: 5_000,
      memoryFloors: { hostAvailableMebibytesMinimum: 4096 },
      memorySampler: async () => ({
        takenAtMilliseconds: Date.now(),
        hostAvailableMebibytes: readings[Math.min(readingIndex++, readings.length - 1)],
        freshProcessDeviceLocalBudgetMebibytes: null,
      }),
      requests: [{ requestIdentifier: 'solo', workload: 'title', cacheState: 'cold', messages: [], mocks: {}, foreignMarkers: [], maxOutputTokens: 16 }],
    });

    // The pre-run reading (4200) passes the 4096 floor, so the request runs; the
    // runtime reading (4050) crosses it and is recorded as a breach after completion.
    expect(report.samples[0].outcome).toBe('completed');
    expect(report.memorySamples.length).toBeGreaterThanOrEqual(2);
    expect(report.safetyBreaches.join(' ')).toMatch(/host/i);
  });

  it('honours per-request output budgets and passes them to the transport', async () => {
    const seenBudgets: Record<string, number> = {};
    const base = makeTransportWithClock({
      preflight: { slots: 2, contextPerSlot: 24576, modelPath: 'x.gguf', attentionCacheType: 'f16', kvUnified: false },
      requests: [{ requestIdentifier: 'budgeted', events: [{ atMs: 0, channel: 'content', text: 'ok' }, { atMs: 50, finishReason: 'stop' }] }],
    });
    const transport: TrialTransport = {
      preflight: base.preflight,
      async stream(request: TrialRequestWirePayload, signal: AbortSignal) {
        seenBudgets[request.requestIdentifier] = request.maxOutputTokens;
        return base.stream(request, signal);
      },
    };

    await runSlotTrial({
      transport,
      profileLabel: 'P3',
      expectedSlots: 2,
      expectedContextPerSlot: 24576,
      maxConcurrency: 2,
      maxRequests: 10,
      durationBudgetMs: 5_000,
      requests: [{ requestIdentifier: 'budgeted', workload: 'title', cacheState: 'cold', messages: [], mocks: {}, foreignMarkers: [], maxOutputTokens: 16 }],
    });

    expect(seenBudgets.budgeted).toBe(16);
  });
});
