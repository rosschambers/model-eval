import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveBaseline, loadBaseline } from './baseline-cache.js';
import type { RawRecord } from './run.js';

function rec(over: Partial<RawRecord>): RawRecord {
  return {
    profile: 'hugo',
    caseId: 'c',
    capability: 'cal',
    model: 'qwen-agentic',
    repeat: 0,
    transcript: { toolCalls: [], finalText: 'ok', iterations: 1, latencyMs: 100 },
    scores: [{ assertion: { kind: 'noFabrication' }, passed: true, detail: '' }],
    ...over,
  };
}

describe('baseline-cache', () => {
  it('round-trips records through save then load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baselines-'));
    const records: RawRecord[] = [rec({ caseId: 'c1' }), rec({ caseId: 'c2', profile: 'murmur8' })];
    saveBaseline(dir, 'qwen-agentic', records);
    expect(existsSync(join(dir, 'qwen-agentic.jsonl'))).toBe(true);

    const loaded = loadBaseline(dir, 'qwen-agentic');
    expect(loaded).toEqual(records);
  });

  it('creates the directory if it does not exist', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'baselines-')), 'nested', 'deep');
    saveBaseline(dir, 'x', [rec({})]);
    expect(loadBaseline(dir, 'x')).toHaveLength(1);
  });

  it('overwrites an existing baseline file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baselines-'));
    saveBaseline(dir, 'x', [rec({ caseId: 'a' }), rec({ caseId: 'b' })]);
    saveBaseline(dir, 'x', [rec({ caseId: 'c' })]);
    const loaded = loadBaseline(dir, 'x');
    expect(loaded).toHaveLength(1);
    expect(loaded![0].caseId).toBe('c');
  });

  it('returns null when the baseline id is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baselines-'));
    expect(loadBaseline(dir, 'nope')).toBeNull();
  });
});
