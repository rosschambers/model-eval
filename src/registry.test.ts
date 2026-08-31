import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRegistry } from './registry.js';
import type { RawRecord } from './run.js';

function rec(over: Partial<RawRecord>): RawRecord {
  return {
    profile: 'hugo',
    caseId: 'c',
    capability: 'cal',
    model: 'm',
    repeat: 0,
    transcript: { toolCalls: [], finalText: '', iterations: 1, latencyMs: 100 },
    scores: [{ assertion: { kind: 'noFabrication' }, passed: true, detail: '' }],
    ...over,
  };
}

function readLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe('appendRegistry', () => {
  it('appends one JSONL line per profile×model with the expected fields, source live', () => {
    const dir = mkdtempSync(join(tmpdir(), 'registry-'));
    const path = join(dir, 'registry.jsonl');
    const records: RawRecord[] = [
      rec({ profile: 'hugo', model: 'm' }),
      rec({ profile: 'murmur8', model: 'm' }),
      rec({ profile: 'hugo', model: 'qwen-agentic' }),
    ];

    appendRegistry(records, { gitSha: 'abc123', timestamp: 'TS', registryPath: path });

    const lines = readLines(path);
    expect(lines).toHaveLength(3);
    const first = lines[0];
    expect(first).toMatchObject({
      timestamp: 'TS',
      gitSha: 'abc123',
      profile: 'hugo',
      model: 'm',
      source: 'live',
    });
    expect(first).toHaveProperty('toolCorrectness');
    expect(first).toHaveProperty('casePassRate');
    expect(first).toHaveProperty('latencyMeanMs');
    expect(first).toHaveProperty('latencyP95Ms');
    expect(first).toHaveProperty('ran');
    expect(first).toHaveProperty('errored');
  });

  it('marks rows for cachedIds models as source cached', () => {
    const dir = mkdtempSync(join(tmpdir(), 'registry-'));
    const path = join(dir, 'registry.jsonl');
    const records: RawRecord[] = [
      rec({ profile: 'hugo', model: 'm' }),
      rec({ profile: 'hugo', model: 'qwen-agentic' }),
    ];

    appendRegistry(records, {
      gitSha: 'abc123',
      timestamp: 'TS',
      registryPath: path,
      cachedIds: new Set(['qwen-agentic']),
    });

    const lines = readLines(path);
    const byModel = Object.fromEntries(lines.map((l) => [l.model as string, l.source]));
    expect(byModel['m']).toBe('live');
    expect(byModel['qwen-agentic']).toBe('cached');
  });

  it('creates the file if absent and appends (does not overwrite) on a second call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'registry-'));
    const path = join(dir, 'registry.jsonl');
    expect(existsSync(path)).toBe(false);

    appendRegistry([rec({ profile: 'hugo', model: 'm' })], {
      gitSha: 'a',
      timestamp: 'T1',
      registryPath: path,
    });
    appendRegistry([rec({ profile: 'murmur8', model: 'm' })], {
      gitSha: 'b',
      timestamp: 'T2',
      registryPath: path,
    });

    const lines = readLines(path);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ timestamp: 'T1', profile: 'hugo' });
    expect(lines[1]).toMatchObject({ timestamp: 'T2', profile: 'murmur8' });
  });
});
