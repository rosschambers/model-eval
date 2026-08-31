// Durable run registry. Aggregates a run's raw records (reusing buildSummary)
// into one summary line per profile×model and appends them as JSONL to a
// committable `registry.jsonl`, so comparisons accumulate across runs. Each line
// is tagged with the git sha, the run timestamp, and whether the model's rows
// came from a live benchmark or a reused baseline cache.

import { appendFileSync } from 'node:fs';
import { buildSummary } from './summary.js';
import type { RawRecord } from './run.js';

export interface RegistryLine {
  timestamp: string;
  gitSha: string;
  profile: string;
  model: string;
  toolCorrectness: number;
  casePassRate: number;
  latencyMeanMs: number;
  latencyP95Ms: number;
  ran: number;
  errored: number;
  source: 'live' | 'cached';
}

export interface AppendRegistryOptions {
  gitSha: string;
  timestamp: string;
  registryPath: string | URL;
  cachedIds?: Set<string>;
}

/** Append one summary line per profile×model from `records` to the registry. */
export function appendRegistry(records: RawRecord[], opts: AppendRegistryOptions): void {
  const rows = buildSummary(records);
  const body = rows
    .map((row) => {
      const line: RegistryLine = {
        timestamp: opts.timestamp,
        gitSha: opts.gitSha,
        profile: row.profile,
        model: row.model,
        toolCorrectness: row.toolCorrectness,
        casePassRate: row.casePassRate,
        latencyMeanMs: row.latencyMeanMs,
        latencyP95Ms: row.latencyP95Ms,
        ran: row.ran,
        errored: row.errored,
        source: opts.cachedIds?.has(row.model) ? 'cached' : 'live',
      };
      return JSON.stringify(line);
    })
    .join('\n');
  if (body.length === 0) return;
  appendFileSync(opts.registryPath, body + '\n', 'utf8');
}
