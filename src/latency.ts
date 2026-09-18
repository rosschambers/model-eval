// Per-request latency collection and aggregation. Standalone and injectable:
// callers wrap a model call with start()/finish() and later summarize() the
// accumulated records. Not wired into loop.ts yet — see the note at the
// bottom of this file for the follow-up.

/**
 * One completed timing sample. `stage` distinguishes the raw text-completion
 * API latency from the "full spoken" latency (the time the user actually
 * waits, including any text-to-speech or audio playback on top of the API
 * call), so a report can compare the two separately.
 */
export interface LatencyRecord {
  requestId: string;
  stage: 'text-api' | 'full-spoken';
  durationMs: number;
  promptTokens: number;
  cachedPromptTokens: number;
  outputTokens: number;
  modelCalls: number;
  toolTimeMs: number;
  config: string;
}

export interface LatencySummary {
  samples: number;
  mean: number;
  median: number;
  p95: number;
}

/** Fields supplied when a timed operation completes. */
export interface LatencyFinishInput {
  promptTokens: number;
  cachedPromptTokens: number;
  outputTokens: number;
  modelCalls: number;
  toolTimeMs: number;
}

/** Handle returned by `start()`; call `finish()` once the operation completes. */
export interface LatencyHandle {
  finish(input: LatencyFinishInput): LatencyRecord;
}

export interface LatencyCollectorOptions {
  /** Injectable clock, defaults to Date.now. Enables deterministic tests. */
  now?: () => number;
}

/**
 * Collects LatencyRecords for a series of timed operations. The clock is
 * injectable so tests can advance time by known amounts and assert exact
 * durations instead of racing the wall clock.
 */
export class LatencyCollector {
  private readonly now: () => number;
  private readonly recorded: LatencyRecord[] = [];

  constructor(options: LatencyCollectorOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Begin timing one request. Returns a handle to finish() once it completes. */
  start(
    requestId: string,
    stage: LatencyRecord['stage'],
    config: string,
  ): LatencyHandle {
    const startedAt = this.now();
    return {
      finish: (input: LatencyFinishInput): LatencyRecord => {
        const record: LatencyRecord = {
          requestId,
          stage,
          durationMs: this.now() - startedAt,
          promptTokens: input.promptTokens,
          cachedPromptTokens: input.cachedPromptTokens,
          outputTokens: input.outputTokens,
          modelCalls: input.modelCalls,
          toolTimeMs: input.toolTimeMs,
          config,
        };
        this.recorded.push(record);
        return record;
      },
    };
  }

  /** All records collected so far, in completion order. */
  records(): LatencyRecord[] {
    return this.recorded;
  }
}

export interface SummarizeFilter {
  stage?: LatencyRecord['stage'];
}

/**
 * Aggregate a set of LatencyRecords into sample count, mean, median, and p95
 * of durationMs. Optionally filter to a single stage first.
 *
 * Definitions:
 * - median: durations sorted ascending; for an odd count, the middle value;
 *   for an even count, the average of the two middle values.
 * - p95: durations sorted ascending; the value at index
 *   ceil(0.95 * n) - 1 (a "nearest-rank" tail estimate — for n=5 that is
 *   index 4, i.e. the maximum; for n=20 that is index 18, the 19th value).
 */
export function summarize(
  records: LatencyRecord[],
  filter: SummarizeFilter = {},
): LatencySummary {
  const filtered =
    filter.stage === undefined
      ? records
      : records.filter((record) => record.stage === filter.stage);

  const samples = filtered.length;
  if (samples === 0) {
    return { samples: 0, mean: 0, median: 0, p95: 0 };
  }

  const durations = filtered.map((record) => record.durationMs).sort((a, b) => a - b);

  const mean = durations.reduce((sum, value) => sum + value, 0) / samples;

  const mid = Math.floor(samples / 2);
  const median =
    samples % 2 === 0 ? (durations[mid - 1] + durations[mid]) / 2 : durations[mid];

  const p95Index = Math.ceil(0.95 * samples) - 1;
  const p95 = durations[p95Index];

  return { samples, mean, median, p95 };
}

// Follow-up: loop.ts currently tracks its own cumulative latencyMs inline
// (see runLoop's t0/latencyMs bookkeeping). Wiring LatencyCollector into
// runLoop — timing each client.chat.completions.create call as a "text-api"
// stage record, tagged with a per-run config identity string — is left as a
// follow-up task so this change stays scoped to a standalone, independently
// testable module.
