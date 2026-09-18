import { describe, it, expect } from 'vitest';
import { LatencyCollector, summarize, type LatencyRecord } from './latency.js';

describe('LatencyCollector', () => {
  it('records exact duration using the injected clock', () => {
    let now = 1000;
    const collector = new LatencyCollector({ now: () => now });

    const handle = collector.start('req-1', 'text-api', 'model-x@t=0');
    now += 42;
    handle.finish({
      promptTokens: 100,
      cachedPromptTokens: 20,
      outputTokens: 30,
      modelCalls: 1,
      toolTimeMs: 5,
    });

    const records = collector.records();
    expect(records.length).toBe(1);
    expect(records[0].durationMs).toBe(42);
  });

  it('defaults the clock to Date.now when none is supplied', () => {
    const collector = new LatencyCollector();
    const handle = collector.start('req-1', 'text-api', 'model-x');
    const record = handle.finish({
      promptTokens: 1,
      cachedPromptTokens: 0,
      outputTokens: 1,
      modelCalls: 1,
      toolTimeMs: 0,
    });
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('round-trips all fields supplied to start/finish', () => {
    let now = 0;
    const collector = new LatencyCollector({ now: () => now });

    const handle = collector.start('req-42', 'full-spoken', 'model-y@config=abc');
    now += 500;
    const record = handle.finish({
      promptTokens: 250,
      cachedPromptTokens: 100,
      outputTokens: 60,
      modelCalls: 3,
      toolTimeMs: 75,
    });

    expect(record).toEqual<LatencyRecord>({
      requestId: 'req-42',
      stage: 'full-spoken',
      durationMs: 500,
      promptTokens: 250,
      cachedPromptTokens: 100,
      outputTokens: 60,
      modelCalls: 3,
      toolTimeMs: 75,
      config: 'model-y@config=abc',
    });
  });

  it('accumulates multiple records across separate start/finish calls', () => {
    let now = 0;
    const collector = new LatencyCollector({ now: () => now });

    const h1 = collector.start('req-1', 'text-api', 'model-x');
    now += 10;
    h1.finish({ promptTokens: 1, cachedPromptTokens: 0, outputTokens: 1, modelCalls: 1, toolTimeMs: 0 });

    const h2 = collector.start('req-2', 'full-spoken', 'model-x');
    now += 20;
    h2.finish({ promptTokens: 2, cachedPromptTokens: 0, outputTokens: 2, modelCalls: 1, toolTimeMs: 0 });

    expect(collector.records().length).toBe(2);
    expect(collector.records()[0].requestId).toBe('req-1');
    expect(collector.records()[1].requestId).toBe('req-2');
  });
});

function makeRecord(overrides: Partial<LatencyRecord> = {}): LatencyRecord {
  return {
    requestId: 'r',
    stage: 'text-api',
    durationMs: 0,
    promptTokens: 0,
    cachedPromptTokens: 0,
    outputTokens: 0,
    modelCalls: 1,
    toolTimeMs: 0,
    config: 'model-x',
    ...overrides,
  };
}

describe('summarize', () => {
  it('computes samples/mean/median/p95 on a known set', () => {
    const durations = [10, 20, 30, 40, 100];
    const records = durations.map((durationMs, i) =>
      makeRecord({ requestId: `r${i}`, durationMs }),
    );

    const summary = summarize(records);

    expect(summary.samples).toBe(5);
    expect(summary.mean).toBe(40);
    expect(summary.median).toBe(30);
    // p95: ceil(0.95 * 5) - 1 = ceil(4.75) - 1 = 5 - 1 = 4 -> sorted[4] = 100
    expect(summary.p95).toBe(100);
  });

  it('averages the two middle values for an even sample count', () => {
    const durations = [10, 20, 30, 40];
    const records = durations.map((durationMs, i) =>
      makeRecord({ requestId: `r${i}`, durationMs }),
    );

    const summary = summarize(records);

    expect(summary.samples).toBe(4);
    expect(summary.median).toBe(25);
  });

  it('returns zeroed summary for an empty record set', () => {
    const summary = summarize([]);
    expect(summary).toEqual({ samples: 0, mean: 0, median: 0, p95: 0 });
  });

  it('is order-independent — sorts durations before computing stats', () => {
    const records = [100, 10, 40, 20, 30].map((durationMs, i) =>
      makeRecord({ requestId: `r${i}`, durationMs }),
    );

    const summary = summarize(records);

    expect(summary.median).toBe(30);
    expect(summary.p95).toBe(100);
  });

  it('filters by stage before summarizing', () => {
    const records: LatencyRecord[] = [
      makeRecord({ requestId: 'a', stage: 'text-api', durationMs: 10 }),
      makeRecord({ requestId: 'b', stage: 'text-api', durationMs: 20 }),
      makeRecord({ requestId: 'c', stage: 'full-spoken', durationMs: 200 }),
      makeRecord({ requestId: 'd', stage: 'full-spoken', durationMs: 400 }),
    ];

    const textApiSummary = summarize(records, { stage: 'text-api' });
    const fullSpokenSummary = summarize(records, { stage: 'full-spoken' });

    expect(textApiSummary.samples).toBe(2);
    expect(textApiSummary.mean).toBe(15);
    expect(fullSpokenSummary.samples).toBe(2);
    expect(fullSpokenSummary.mean).toBe(300);
  });

  it('summarizes all records when no filter is supplied', () => {
    const records: LatencyRecord[] = [
      makeRecord({ requestId: 'a', stage: 'text-api', durationMs: 10 }),
      makeRecord({ requestId: 'c', stage: 'full-spoken', durationMs: 200 }),
    ];

    const summary = summarize(records);

    expect(summary.samples).toBe(2);
  });
});
