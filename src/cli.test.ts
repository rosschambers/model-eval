import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, runCommand, type RunDeps } from './cli.js';
import type { ParsedArgs } from './cli.js';
import type { RawRecord } from './run.js';
import type { ModelConfig } from './models.js';

describe('parseArgs', () => {
  it('parses a full run command', () => {
    const args = parseArgs([
      'run',
      'owner/repo',
      '--profile',
      'hugo,murmur8',
      '--case',
      'cal-tz-01',
      '--baseline',
      'haiku',
      '--keep',
    ]);
    expect(args).toEqual({
      command: 'run',
      hfSpec: 'owner/repo',
      profiles: ['hugo', 'murmur8'],
      caseId: 'cal-tz-01',
      baseline: 'haiku',
      keep: true,
    });
  });

  it('parses a bare run command', () => {
    const args = parseArgs(['run', 'owner/repo']);
    expect(args.command).toBe('run');
    expect(args.hfSpec).toBe('owner/repo');
    expect(args.keep).toBe(false);
    expect(args.profiles).toBeUndefined();
  });

  it('parses a serve command with a port', () => {
    const args = parseArgs(['serve', 'owner/repo', '--port', '8090']);
    expect(args).toMatchObject({ command: 'serve', hfSpec: 'owner/repo', port: 8090, keep: false });
  });

  it('parses a stop command with a port', () => {
    const args = parseArgs(['stop', '--port', '8090']);
    expect(args).toMatchObject({ command: 'stop', port: 8090, keep: false });
  });

  it('throws on an unknown command', () => {
    expect(() => parseArgs(['frobnicate'])).toThrow(/usage/i);
  });

  it('throws when run is missing the hfSpec', () => {
    expect(() => parseArgs(['run'])).toThrow('run requires a HuggingFace repo spec');
  });

  it('keeps the baseline arg as a raw value without interpreting it', () => {
    expect(parseArgs(['run', 'owner/repo', '--baseline', 'none']).baseline).toBe('none');
    expect(parseArgs(['run', 'owner/repo', '--baseline', 'cached:qwen-agentic']).baseline).toBe(
      'cached:qwen-agentic',
    );
    expect(parseArgs(['run', 'owner/repo', '--baseline', 'qwen-agentic']).baseline).toBe(
      'qwen-agentic',
    );
    expect(parseArgs(['run', 'owner/repo']).baseline).toBeUndefined();
  });
});

function fakeRecord(model: string, over: Partial<RawRecord> = {}): RawRecord {
  return {
    profile: 'hugo',
    caseId: 'c',
    capability: 'cal',
    model,
    repeat: 0,
    transcript: { toolCalls: [], finalText: 'ok', iterations: 1, latencyMs: 1 },
    scores: [],
    ...over,
  };
}

interface Spy {
  deps: RunDeps;
  serveCalls: number;
  stopCalls: number[];
  runModels: string[];
  writes: Record<string, boolean>;
  writeRawRecords: RawRecord[];
  writeSummaryRecords: RawRecord[];
  saveBaselineCalls: { id: string; records: RawRecord[] }[];
  appendRegistryCalls: { records: RawRecord[]; cachedIds?: Set<string>; gitSha: string; timestamp: string }[];
  loadBaselineReturn: RawRecord[] | null;
}

function makeSpy(): Spy {
  const spy: Spy = {
    serveCalls: 0,
    stopCalls: [],
    runModels: [],
    writes: { raw: false, scores: false, summary: false, bundle: false },
    writeRawRecords: [],
    writeSummaryRecords: [],
    saveBaselineCalls: [],
    appendRegistryCalls: [],
    loadBaselineReturn: null,
    deps: {} as RunDeps,
  };
  spy.deps = {
    resolveGguf: async () => ({ repo: 'r', file: 'm.gguf' }),
    serveOnFrame: async () => {
      spy.serveCalls += 1;
      return { port: 8086, baseURL: 'http://frame:8086/v1' };
    },
    waitReady: async () => true,
    stopOnFrame: async (port: number) => {
      spy.stopCalls.push(port);
    },
    runProfiles: async (models: ModelConfig[]) => {
      spy.runModels = models.map((m) => m.id);
      return models.map((m) => fakeRecord(m.id));
    },
    writeRaw: (_dir, records) => {
      spy.writes.raw = true;
      spy.writeRawRecords = records;
    },
    writeScores: () => {
      spy.writes.scores = true;
    },
    writeSummary: (_dir, records) => {
      spy.writes.summary = true;
      spy.writeSummaryRecords = records;
    },
    writeBundle: () => {
      spy.writes.bundle = true;
    },
    saveBaseline: (_dir, id, records) => {
      spy.saveBaselineCalls.push({ id, records });
    },
    loadBaseline: () => spy.loadBaselineReturn,
    appendRegistry: (records, opts) => {
      spy.appendRegistryCalls.push({
        records,
        cachedIds: opts.cachedIds,
        gitSha: opts.gitSha,
        timestamp: opts.timestamp,
      });
    },
    now: () => 'TS',
    resultsBase: mkdtempSync(join(tmpdir(), 'cli-results-')),
    baselinesDir: mkdtempSync(join(tmpdir(), 'cli-baselines-')),
    registryPath: join(mkdtempSync(join(tmpdir(), 'cli-registry-')), 'registry.jsonl'),
    gitSha: 'deadbee',
  };
  return spy;
}

describe('runCommand', () => {
  it('leaves the server running when --keep is set', async () => {
    const spy = makeSpy();
    const args: ParsedArgs = { command: 'run', hfSpec: 'owner/repo', keep: true };
    await runCommand(args, spy.deps);

    expect(spy.serveCalls).toBe(1);
    expect(spy.stopCalls).toEqual([]);
  });

  describe('baseline live (default)', () => {
    it('benchmarks candidate + baseline, refreshes the cache, and records live', async () => {
      const spy = makeSpy();
      const args: ParsedArgs = { command: 'run', hfSpec: 'owner/repo', keep: false };
      await runCommand(args, spy.deps);

      expect(spy.serveCalls).toBe(1);
      expect(spy.runModels).toEqual(['m', 'qwen-agentic']);
      expect(spy.writes).toEqual({ raw: true, scores: true, summary: true, bundle: true });
      expect(spy.stopCalls).toEqual([8086]);

      expect(spy.saveBaselineCalls).toHaveLength(1);
      expect(spy.saveBaselineCalls[0].id).toBe('qwen-agentic');
      expect(spy.saveBaselineCalls[0].records.map((r) => r.model)).toEqual(['qwen-agentic']);

      expect(spy.appendRegistryCalls).toHaveLength(1);
      const reg = spy.appendRegistryCalls[0];
      expect(reg.cachedIds?.size ?? 0).toBe(0);
      expect(reg.gitSha).toBe('deadbee');
      expect(reg.timestamp).toBe('TS');
    });
  });

  describe('registered local candidate', () => {
    it('uses a registered local model directly without resolving or serving from HF', async () => {
      const spy = makeSpy();
      const args: ParsedArgs = { command: 'run', hfSpec: 'crucible-4b', keep: false };
      await runCommand(args, spy.deps);

      expect(spy.serveCalls).toBe(0);
      expect(spy.stopCalls).toEqual([]);
      expect(spy.runModels).toEqual(['crucible-4b', 'qwen-agentic']);
    });
  });

  describe('baseline none', () => {
    it('runs only the candidate, never serves/saves the baseline', async () => {
      const spy = makeSpy();
      const args: ParsedArgs = { command: 'run', hfSpec: 'owner/repo', baseline: 'none', keep: false };
      await runCommand(args, spy.deps);

      expect(spy.runModels).toEqual(['m']);
      expect(spy.saveBaselineCalls).toHaveLength(0);
      expect(spy.writeRawRecords.map((r) => r.model)).toEqual(['m']);
      expect(spy.appendRegistryCalls[0].cachedIds?.size ?? 0).toBe(0);
    });
  });

  describe('baseline cached', () => {
    it('folds stored baseline rows in without serving the baseline', async () => {
      const spy = makeSpy();
      spy.loadBaselineReturn = [fakeRecord('qwen-agentic', { caseId: 'c' })];
      const args: ParsedArgs = {
        command: 'run',
        hfSpec: 'owner/repo',
        baseline: 'cached:qwen-agentic',
        keep: false,
      };
      await runCommand(args, spy.deps);

      expect(spy.runModels).toEqual(['m']);
      expect(spy.saveBaselineCalls).toHaveLength(0);
      expect(spy.writeRawRecords.map((r) => r.model).sort()).toEqual(['m', 'qwen-agentic']);
      expect(spy.writeSummaryRecords.map((r) => r.model).sort()).toEqual(['m', 'qwen-agentic']);
      expect([...(spy.appendRegistryCalls[0].cachedIds ?? [])]).toEqual(['qwen-agentic']);
    });

    it('throws when no cached baseline exists', async () => {
      const spy = makeSpy();
      spy.loadBaselineReturn = null;
      const args: ParsedArgs = {
        command: 'run',
        hfSpec: 'owner/repo',
        baseline: 'cached:qwen-agentic',
        keep: false,
      };
      await expect(runCommand(args, spy.deps)).rejects.toThrow(/no cached baseline for qwen-agentic/);
    });
  });
});
