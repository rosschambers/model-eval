// summary.json emitter. Aggregates raw records into one row per profile×model:
// tool correctness, case pass rate, latency mean/p95, and run counts. Errored
// records are excluded from correctness and latency but counted in `errored`.

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { RawRecord } from './run.js';

export interface SummaryRow {
  profile: string;
  model: string;
  toolCorrectness: number;
  casePassRate: number;
  latencyMeanMs: number;
  latencyP95Ms: number;
  ran: number;
  errored: number;
}

function fileInDir(dir: URL | string, name: string): URL {
  if (typeof dir === 'string') {
    const base = dir.endsWith('/') ? dir : `${dir}/`;
    return new URL(name, pathToFileURL(base));
  }
  return new URL(name, dir);
}

/** Nearest-rank p95 over an unsorted list of latencies. */
function p95(latencies: number[]): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[rank - 1];
}

export function buildSummary(records: RawRecord[]): SummaryRow[] {
  const groups = new Map<string, RawRecord[]>();
  for (const record of records) {
    const key = `${record.profile}\u0000${record.model}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(record);
    else groups.set(key, [record]);
  }

  const rows: SummaryRow[] = [];
  for (const bucket of groups.values()) {
    const ok = bucket.filter((r) => !r.error);
    const errored = bucket.length - ok.length;

    let assertionsPassed = 0;
    let assertionsTotal = 0;
    let casePass = 0;
    const latencies: number[] = [];

    for (const record of ok) {
      const passed = record.scores.filter((s) => s.passed).length;
      assertionsPassed += passed;
      assertionsTotal += record.scores.length;
      if (passed === record.scores.length) casePass += 1;
      if (record.transcript) latencies.push(record.transcript.latencyMs);
    }

    const ran = ok.length;
    rows.push({
      profile: bucket[0].profile,
      model: bucket[0].model,
      toolCorrectness: assertionsTotal === 0 ? 0 : assertionsPassed / assertionsTotal,
      casePassRate: ran === 0 ? 0 : casePass / ran,
      latencyMeanMs: latencies.length === 0 ? 0 : latencies.reduce((a, b) => a + b, 0) / latencies.length,
      latencyP95Ms: p95(latencies),
      ran,
      errored,
    });
  }

  return rows;
}

export function writeSummary(dir: URL | string, records: RawRecord[]): void {
  writeFileSync(fileInDir(dir, 'summary.json'), JSON.stringify(buildSummary(records), null, 2), 'utf8');
}
