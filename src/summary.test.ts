import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSummary, writeSummary } from './summary.js';
import type { RawRecord } from './run.js';

function rec(over: Partial<RawRecord>): RawRecord {
  return {
    profile: 'hugo',
    caseId: 'c',
    capability: 'cal',
    model: 'haiku',
    repeat: 0,
    transcript: { toolCalls: [], finalText: '', iterations: 1, latencyMs: 0 },
    scores: [],
    ...over,
  };
}

const RECORDS: RawRecord[] = [
  rec({
    caseId: 'c1',
    transcript: { toolCalls: [], finalText: 'a', iterations: 1, latencyMs: 100 },
    scores: [
      { assertion: { kind: 'noFabrication' }, passed: true, detail: '' },
      { assertion: { kind: 'noFabrication' }, passed: true, detail: '' },
    ],
  }),
  rec({
    caseId: 'c2',
    transcript: { toolCalls: [], finalText: 'b', iterations: 1, latencyMs: 200 },
    scores: [
      { assertion: { kind: 'noFabrication' }, passed: true, detail: '' },
      { assertion: { kind: 'noFabrication' }, passed: false, detail: '' },
    ],
  }),
  rec({
    caseId: 'c3',
    transcript: { toolCalls: [], finalText: 'c', iterations: 1, latencyMs: 300 },
    scores: [
      { assertion: { kind: 'noFabrication' }, passed: true, detail: '' },
      { assertion: { kind: 'noFabrication' }, passed: true, detail: '' },
    ],
  }),
  rec({ caseId: 'c4', transcript: null, scores: [], error: 'boom' }),
];

describe('buildSummary', () => {
  it('aggregates one row per profile+model with exact mean and p95', () => {
    const rows = buildSummary(RECORDS);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.profile).toBe('hugo');
    expect(row.model).toBe('haiku');
    expect(row.ran).toBe(3);
    expect(row.errored).toBe(1);
    expect(row.latencyMeanMs).toBe(200);
    expect(row.latencyP95Ms).toBe(300);
    expect(row.toolCorrectness).toBeCloseTo(5 / 6, 6);
    expect(row.casePassRate).toBeCloseTo(2 / 3, 6);
  });

  it('reports zero correctness when a group has only errored records', () => {
    const rows = buildSummary([rec({ transcript: null, scores: [], error: 'x' })]);
    expect(rows[0]).toMatchObject({
      ran: 0,
      errored: 1,
      toolCorrectness: 0,
      casePassRate: 0,
      latencyMeanMs: 0,
      latencyP95Ms: 0,
    });
  });
});

describe('writeSummary', () => {
  it('writes pretty summary.json into the dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'summary-'));
    writeSummary(dir, RECORDS);
    const parsed = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].model).toBe('haiku');
  });
});
