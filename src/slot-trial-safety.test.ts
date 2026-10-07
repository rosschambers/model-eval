import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSlotTrial, type SlotTrialOptions, type TrialRequest, type TrialStreamChunk } from './slot-trial.js';

const request: TrialRequest = {
  requestIdentifier: 'one', workload: 'title', cacheState: 'cold',
  messages: [{ role: 'user', content: 'Name this conversation' }],
  foreignMarkers: [], maxOutputTokens: 16,
};

function options(overrides: Partial<SlotTrialOptions> = {}): SlotTrialOptions {
  return {
    profileLabel: 'P1', expectedSlots: 1, expectedContextPerSlot: 24576,
    maxConcurrency: 1, maxRequests: 1, durationBudgetMs: 100,
    requests: [request],
    transport: {
      preflight: vi.fn(async () => ({ slots: 1, contextPerSlot: 24576, modelPath: null, attentionCacheType: null, kvUnified: null })),
      stream: vi.fn(async () => ({ status: 200, chunks: {
        async *[Symbol.asyncIterator]() { yield { choices: [{ delta: { content: 'Project Notes' }, finish_reason: 'stop' }] }; },
      } })),
    },
    ...overrides,
  };
}

describe('trial safety regressions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([0, -1, 1.5, NaN, Infinity, 3])('rejects concurrency %s before preflight', async (maxConcurrency) => {
    const configuration = options({ maxConcurrency });
    await expect(runSlotTrial(configuration)).rejects.toThrow(/concurrency/i);
    expect(configuration.transport.preflight).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects request limit %s', async (maxRequests) => {
    await expect(runSlotTrial(options({ maxRequests }))).rejects.toThrow(/requests/i);
  });

  it.each([0, -1, NaN, Infinity, 2147483648])('rejects duration %s', async (durationBudgetMs) => {
    await expect(runSlotTrial(options({ durationBudgetMs }))).rejects.toThrow(/duration/i);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 24577])('rejects output budget %s', async (maxOutputTokens) => {
    await expect(runSlotTrial(options({ requests: [{ ...request, maxOutputTokens }] }))).rejects.toThrow(/output/i);
  });

  it('rejects too many requests rather than silently truncating or exceeding the cap', async () => {
    const configuration = options({ requests: [request, { ...request, requestIdentifier: 'two' }] });
    await expect(runSlotTrial(configuration)).rejects.toThrow(/requests/i);
    expect(configuration.transport.preflight).not.toHaveBeenCalled();
  });

  it('rejects duplicate identifiers', async () => {
    await expect(runSlotTrial(options({ maxRequests: 2, requests: [request, request] }))).rejects.toThrow(/identifier/i);
  });

  it.each([null, NaN, Infinity, 0, -1])('fails closed for required memory reading %s', async (reading) => {
    const configuration = options({
      memoryFloors: { hostAvailableMebibytesMinimum: 2048 },
      memorySampler: async () => ({ takenAtMilliseconds: 0, hostAvailableMebibytes: reading, freshProcessDeviceLocalBudgetMebibytes: null }),
    });
    const report = await runSlotTrial(configuration);
    expect(report.safetyBreaches.length).toBeGreaterThan(0);
    expect(report.abortedBeforeRequests).toBe(true);
    expect(configuration.transport.stream).not.toHaveBeenCalled();
  });

  it('requires a sampler when a floor is configured', async () => {
    await expect(runSlotTrial(options({ memoryFloors: { hostAvailableMebibytesMinimum: 2048 } }))).rejects.toThrow(/sampler/i);
  });

  it('aborts a stalled stream at the deadline, including the final request', async () => {
    const configuration = options();
    let signal: AbortSignal | undefined;
    configuration.transport.stream = async (_payload, requestSignal) => {
      signal = requestSignal;
      return { status: 200, chunks: { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } } };
    };
    let report: Awaited<ReturnType<typeof runSlotTrial>> | undefined;
    const running = runSlotTrial(configuration).then((result) => { report = result; });
    await vi.advanceTimersByTimeAsync(101);
    expect(signal?.aborted).toBe(true);
    expect(report?.durationBudgetExceeded).toBe(true);
    expect(report?.samples[0].outcome).not.toBe('completed');
    await running;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels independently of output deltas', async () => {
    const configuration = options({ requests: [{ ...request, cancelAfterMilliseconds: 20 }] });
    let signal: AbortSignal | undefined;
    configuration.transport.stream = async (_payload, requestSignal) => {
      signal = requestSignal;
      return new Promise(() => {});
    };
    let report: Awaited<ReturnType<typeof runSlotTrial>> | undefined;
    const running = runSlotTrial(configuration).then((result) => { report = result; });
    await vi.advanceTimersByTimeAsync(21);
    expect(signal?.aborted).toBe(true);
    expect(report?.samples[0].outcome).toBe('cancelled');
    expect(report?.durationBudgetExceeded).toBe(false);
    await running;
  });

  it('checks memory during generation and halts pending work', async () => {
    let calls = 0;
    const configuration = options({
      maxRequests: 2, requests: [request, { ...request, requestIdentifier: 'two' }],
      memoryIntervalMilliseconds: 10, memorySampleTimeoutMilliseconds: 5,
      memoryFloors: { hostAvailableMebibytesMinimum: 2048 },
      memorySampler: async () => ({ takenAtMilliseconds: 0, hostAvailableMebibytes: ++calls === 1 ? 4096 : 1024, freshProcessDeviceLocalBudgetMebibytes: null }),
    });
    configuration.transport.stream = async () => new Promise(() => {});
    let report: Awaited<ReturnType<typeof runSlotTrial>> | undefined;
    const running = runSlotTrial(configuration).then((result) => { report = result; });
    await vi.advanceTimersByTimeAsync(21);
    expect(report?.safetyBreaches.join(' ')).toMatch(/host/i);
    expect(report?.samples[1].outcome).toBe('not_started');
    expect(calls).toBe(2);
    await running;
  });

  it('bounds a hung memory sampler', async () => {
    const configuration = options({ memorySampleTimeoutMilliseconds: 10, memorySampler: async () => new Promise(() => {}) });
    let report: Awaited<ReturnType<typeof runSlotTrial>> | undefined;
    const running = runSlotTrial(configuration).then((result) => { report = result; });
    await vi.advanceTimersByTimeAsync(11);
    expect(report?.safetyBreaches.join(' ')).toMatch(/memory/i);
    expect(configuration.transport.stream).not.toHaveBeenCalled();
    await running;
  });

  it('uses a monotonic clock even when wall time moves backwards', async () => {
    const configuration = options();
    configuration.transport.stream = async () => ({ status: 200, chunks: {
      async *[Symbol.asyncIterator]() {
        vi.setSystemTime(Date.now() - 10000);
        yield { choices: [{ delta: { content: 'Project Notes' }, finish_reason: 'stop' }] };
      },
    } });
    const report = await runSlotTrial(configuration);
    expect(report.samples[0].completedAtMilliseconds! - report.samples[0].startedAtMilliseconds!).toBeGreaterThanOrEqual(0);
  });

  it('detects a final overrun even before the timer gets an event-loop turn', async () => {
    let clock = 0;
    const configuration = options({ now: () => clock });
    configuration.transport.stream = async () => ({ status: 200, chunks: { async *[Symbol.asyncIterator]() {
      clock = 101;
      yield { choices: [{ delta: { content: 'Test Title' }, finish_reason: 'stop' }] };
    } } });
    const report = await runSlotTrial(configuration);
    expect(report.durationBudgetExceeded).toBe(true);
    expect(report.successful).toBe(false);
  });

  it('bounds a stalled preflight without starting requests', async () => {
    const configuration = options();
    configuration.transport.preflight = async () => new Promise(() => {});
    const pending = runSlotTrial(configuration);
    await vi.advanceTimersByTimeAsync(101);
    const report = await pending;
    expect(report.durationBudgetExceeded).toBe(true);
    expect(report.abortedBeforeRequests).toBe(true);
    expect(configuration.transport.stream).not.toHaveBeenCalled();
  });

  it.each(['incorrect arguments', 'malformed arguments', 'foreign marker', 'HTTP failure', 'transport failure', 'truncated response'])('stops admission after %s and retains the entire requested population', async (failure) => {
    const toolFailure = failure === 'incorrect arguments' || failure === 'malformed arguments';
    const expectedArguments = { type: 'tasks', taskListId: 'synthetic-active-board', pageSize: 1 };
    const first: TrialRequest = {
      ...request, workload: 'portal', foreignMarkers: ['FOREIGN'],
      tools: [{ type: 'function', function: { name: 'list', parameters: { type: 'object' } } }],
      expectedToolCalls: toolFailure ? [{ name: 'list', arguments: expectedArguments }] : [],
    };
    const onSample = vi.fn();
    const requests = [first, ...Array.from({ length: 11 }, (_, index) => ({ ...request, requestIdentifier: `pending-${index}` }))];
    const configuration = options({ maxRequests: requests.length, requests, onSample });
    configuration.transport.stream = vi.fn(async (payload) => {
      let status = 200;
      let chunk: TrialStreamChunk = { choices: [{ delta: { content: 'Project Notes' }, finish_reason: 'stop' }] };
      if (payload.requestIdentifier === first.requestIdentifier) {
        if (failure === 'transport failure') throw new Error('synthetic transport failure');
        if (failure === 'HTTP failure') status = 503;
        if (failure === 'foreign marker') chunk = { choices: [{ delta: { content: 'FOREIGN response' }, finish_reason: 'stop' }] };
        if (failure === 'truncated response') chunk = { choices: [{ delta: { content: 'Partial' }, finish_reason: 'length' }] };
        if (toolFailure) {
          const argumentsJson = failure === 'malformed arguments' ? '{"type":' : JSON.stringify({ ...expectedArguments, status: 'NeedsAction' });
          chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'synthetic-call', function: { name: 'list', arguments: argumentsJson } }] }, finish_reason: 'tool_calls' }] };
        }
      }
      return { status, chunks: { async *[Symbol.asyncIterator]() { yield chunk; } } };
    });
    const report = await runSlotTrial(configuration);
    expect(report.samples[0].outcome).toBe('failed');
    expect(configuration.transport.stream).toHaveBeenCalledTimes(1);
    expect(report.outcomeCounts).toEqual({ total: 12, completed: 0, failed: 1, cancelled: 0, not_started: 11 });
    expect(report.samples.map((sample) => sample.requestIdentifier)).toEqual(requests.map((entry) => entry.requestIdentifier));
    expect(report.samples.slice(1).every((sample) => sample.startedAtMilliseconds === null)).toBe(true);
    expect(onSample).toHaveBeenCalledTimes(12);
    expect(report.successful).toBe(false);
    expect(report.durationBudgetExceeded).toBe(false);
    expect(report.latencySummaries).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a still-running neighbor as failed, not intentionally cancelled, after a hard failure', async () => {
    const configuration = options({
      maxConcurrency: 2, maxRequests: 3,
      requests: [request, { ...request, requestIdentifier: 'neighbor', cancelAfterMilliseconds: 80 }, { ...request, requestIdentifier: 'pending' }],
    });
    let neighborSignal: AbortSignal | undefined;
    const started: string[] = [];
    configuration.transport.stream = async (payload, signal) => {
      started.push(payload.requestIdentifier);
      if (payload.requestIdentifier === 'neighbor') neighborSignal = signal;
      return { status: 200, chunks: { async *[Symbol.asyncIterator]() {
        if (payload.requestIdentifier === 'one') {
          await new Promise((resolve) => setTimeout(resolve, 10));
          yield { choices: [{ delta: { content: 'Partial' }, finish_reason: 'length' }] };
        } else if (payload.requestIdentifier === 'neighbor') {
          yield { choices: [{ delta: { content: 'Project ' } }] };
          await new Promise(() => {});
        } else {
          yield { choices: [{ delta: { content: 'Project Notes' }, finish_reason: 'stop' }] };
        }
      } } };
    };
    let report: Awaited<ReturnType<typeof runSlotTrial>> | undefined;
    const running = runSlotTrial(configuration).then((result) => { report = result; });
    await vi.advanceTimersByTimeAsync(11);
    expect(neighborSignal?.aborted).toBe(true);
    expect(started).toEqual(['one', 'neighbor']);
    expect(report?.outcomeCounts).toEqual({ total: 3, completed: 0, failed: 2, cancelled: 0, not_started: 1 });
    expect(report?.samples[1]).toMatchObject({ outcome: 'failed', content: 'Project ' });
    expect(report?.samples[1].validationErrors.join(' ')).toContain('hard correctness failure');
    expect(report?.successful).toBe(false);
    expect(report?.durationBudgetExceeded).toBe(false);
    await running;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not stop admission for a clean intentional cancellation', async () => {
    const configuration = options({ maxRequests: 3, requests: [
      { ...request, cancelAfterMilliseconds: 20, ownMarker: 'not-emitted-before-cancellation' },
      { ...request, requestIdentifier: 'next' }, { ...request, requestIdentifier: 'last' },
    ] });
    const started: string[] = [];
    configuration.transport.stream = async (payload) => {
      started.push(payload.requestIdentifier);
      if (payload.requestIdentifier === 'one') return new Promise(() => {});
      return { status: 200, chunks: { async *[Symbol.asyncIterator]() { yield { choices: [{ delta: { content: 'Project Notes' }, finish_reason: 'stop' }] }; } } };
    };
    const running = runSlotTrial(configuration);
    await vi.advanceTimersByTimeAsync(21);
    const report = await running;
    expect(started).toEqual(['one', 'next', 'last']);
    expect(report.samples[0]).toMatchObject({ outcome: 'cancelled', validationErrors: [] });
    expect(report.outcomeCounts).toEqual({ total: 3, completed: 2, failed: 0, cancelled: 1, not_started: 0 });
    expect(report.durationBudgetExceeded).toBe(false);
    expect(report.successful).toBe(false);
  });

  it('still fails on deadline expiry after a clean intentional cancellation', async () => {
    const configuration = options({ maxRequests: 3, requests: [
      { ...request, cancelAfterMilliseconds: 20 }, { ...request, requestIdentifier: 'stalled' }, { ...request, requestIdentifier: 'pending' },
    ] });
    configuration.transport.stream = async () => new Promise(() => {});
    const running = runSlotTrial(configuration);
    await vi.advanceTimersByTimeAsync(101);
    const report = await running;
    expect(report.outcomeCounts).toEqual({ total: 3, completed: 0, failed: 1, cancelled: 1, not_started: 1 });
    expect(report.durationBudgetExceeded).toBe(true);
    expect(report.successful).toBe(false);
  });

  it('does not exempt foreign output from a hard stop just because cancellation was intentional', async () => {
    const configuration = options({ maxRequests: 2, requests: [
      { ...request, cancelAfterDelta: 1, foreignMarkers: ['FOREIGN'] }, { ...request, requestIdentifier: 'pending' },
    ] });
    configuration.transport.stream = vi.fn(async () => ({ status: 200, chunks: {
      async *[Symbol.asyncIterator]() { yield { choices: [{ delta: { content: 'FOREIGN response' } }] }; },
    } }));
    const report = await runSlotTrial(configuration);
    expect(configuration.transport.stream).toHaveBeenCalledTimes(1);
    expect(report.samples[0]).toMatchObject({ outcome: 'failed', foreignMarkers: ['FOREIGN'] });
    expect(report.outcomeCounts).toEqual({ total: 2, completed: 0, failed: 1, cancelled: 0, not_started: 1 });
    expect(report.successful).toBe(false);
  });
});
