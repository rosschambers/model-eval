// Baseline record cache. Stores a baseline model's raw records as JSONL under
// `<dir>/<id>.jsonl` so a later run can reuse them (--baseline cached:<id>)
// without re-serving or re-benchmarking the baseline. Live runs refresh the
// cache; cached runs load it.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { RawRecord } from './run.js';

function fileInDir(dir: URL | string, name: string): URL {
  if (typeof dir === 'string') {
    const base = dir.endsWith('/') ? dir : `${dir}/`;
    return new URL(name, pathToFileURL(base));
  }
  return new URL(name, dir);
}

/** Write `records` as JSONL to `<dir>/<id>.jsonl`, creating `dir` if needed. */
export function saveBaseline(dir: URL | string, id: string, records: RawRecord[]): void {
  mkdirSync(dir, { recursive: true });
  const body = records.length ? records.map((r) => JSON.stringify(r)).join('\n') + '\n' : '';
  writeFileSync(fileInDir(dir, `${id}.jsonl`), body, 'utf8');
}

/** Read `<dir>/<id>.jsonl`; return the parsed records, or null if absent. */
export function loadBaseline(dir: URL | string, id: string): RawRecord[] | null {
  const path = fileInDir(dir, `${id}.jsonl`);
  if (!existsSync(path)) return null;
  const body = readFileSync(path, 'utf8');
  return body
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RawRecord);
}
