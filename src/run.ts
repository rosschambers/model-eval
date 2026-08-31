// Runner entrypoint. Drives every selected model through every selected profile
// and its cases, scores the resulting transcript, and writes results to a
// timestamped dir. A failure for one model/profile/case is recorded and never
// aborts the sweep.
//
//   npx tsx src/run.ts [--model <id>[,<id>...]] [--profile <id>[,<id>...]]
//                       [--case <id>] [--repeat <N>]
//                       [--intervention structural|verify]

import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MODELS } from './models.js';
import { getClient } from './models.js';
import type { ModelConfig } from './models.js';
import { runCase } from './loop.js';
import type { ChatClient } from './loop.js';
import { withStructuralGuard, withVerificationPass, type CaseRunner } from './interventions.js';
import { scoreCase } from './score.js';
import { getProfiles, type AgentProfile } from './profile.js';
import type { BenchCase, Transcript, AssertionResult } from './case.js';

export interface RawRecord {
  profile: string;
  caseId: string;
  capability: string;
  model: string;
  repeat: number;
  transcript: Transcript | null;
  scores: AssertionResult[];
  error?: string;
}

export interface ScoreSummary {
  profile: string;
  caseId: string;
  model: string;
  capability: string;
  passed: number;
  total: number;
  error?: string;
}

interface RunProfileOptions {
  cases?: BenchCase[];
  repeat?: number;
  runner?: CaseRunner;
}

function parseFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

/**
 * Run one model through one profile's cases. Merges the profile's default mocks
 * UNDER each case's own mocks, builds the system prompt and tool surface from
 * the profile, runs each case (reusing runCase or an intervention runner), and
 * scores it. Returns one record per case × repeat, each tagged with the profile
 * id. A failure for any single run is captured in that record and never aborts.
 */
export async function runOneProfile(
  client: ChatClient,
  modelName: string,
  profile: AgentProfile,
  opts: RunProfileOptions = {},
): Promise<RawRecord[]> {
  const cases = opts.cases ?? profile.cases;
  const repeat = opts.repeat ?? 1;
  const runner = opts.runner ?? runCase;
  const sys = profile.buildSystemPrompt();
  const tools = profile.toolDefs;

  const records: RawRecord[] = [];

  for (const c of cases) {
    const mergedMocks = { ...profile.mockDefaults, ...(c.mocks ?? {}) };
    const mergedCase: BenchCase = { ...c, mocks: mergedMocks };

    for (let rep = 0; rep < repeat; rep++) {
      try {
        const transcript = await runner(client, modelName, mergedCase, sys, tools);
        const scores = scoreCase(transcript, c.expect);
        records.push({
          profile: profile.id,
          caseId: c.id,
          capability: c.capability,
          model: modelName,
          repeat: rep,
          transcript,
          scores,
        });
      } catch (err) {
        records.push({
          profile: profile.id,
          caseId: c.id,
          capability: c.capability,
          model: modelName,
          repeat: rep,
          transcript: null,
          scores: [],
          error: String(err),
        });
      }
    }
  }

  return records;
}

function fileInDir(dir: URL | string, name: string): URL {
  if (typeof dir === 'string') {
    const base = dir.endsWith('/') ? dir : `${dir}/`;
    return new URL(name, pathToFileURL(base));
  }
  return new URL(name, dir);
}

/**
 * Drive every model through every profile (filtered by caseId when given) using
 * the real OpenAI-compatible client. Each record's `model` is rewritten from the
 * resolved model name to the stable model id. Returns every produced record.
 */
export async function runProfiles(
  models: ModelConfig[],
  profiles: AgentProfile[],
  opts: { caseId?: string; repeat?: number; runner?: CaseRunner } = {},
): Promise<RawRecord[]> {
  const all: RawRecord[] = [];
  for (const m of models) {
    const client = getClient(m);
    for (const profile of profiles) {
      const cases = opts.caseId
        ? profile.cases.filter((c) => c.id === opts.caseId)
        : profile.cases;
      if (cases.length === 0) continue;
      const records = await runOneProfile(client, m.model, profile, {
        cases,
        repeat: opts.repeat,
        runner: opts.runner,
      });
      for (const record of records) record.model = m.id;
      all.push(...records);
    }
  }
  return all;
}

/** Write every record as one JSON line to `<dir>/raw.jsonl`. */
export function writeRaw(dir: URL | string, records: RawRecord[]): void {
  const body = records.length ? records.map((r) => JSON.stringify(r)).join('\n') + '\n' : '';
  writeFileSync(fileInDir(dir, 'raw.jsonl'), body, 'utf8');
}

/** Write the per-record assertion tallies to `<dir>/scores.json`. */
export function writeScores(dir: URL | string, records: RawRecord[]): void {
  const summaries: ScoreSummary[] = records.map((r) => ({
    profile: r.profile,
    caseId: r.caseId,
    model: r.model,
    capability: r.capability,
    passed: r.scores.filter((s) => s.passed).length,
    total: r.scores.length,
    ...(r.error ? { error: r.error } : {}),
  }));
  writeFileSync(fileInDir(dir, 'scores.json'), JSON.stringify(summaries, null, 2), 'utf8');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const modelFilter = parseFlag(argv, '--model');
  const profileFilter = parseFlag(argv, '--profile');
  const caseFilter = parseFlag(argv, '--case');
  const intervention = parseFlag(argv, '--intervention');

  let runner: CaseRunner;
  if (intervention === 'structural') {
    runner = withStructuralGuard();
  } else if (intervention === 'verify') {
    runner = withVerificationPass();
  } else {
    runner = runCase;
  }

  const repeatRaw = parseFlag(argv, '--repeat');
  const repeatParsed = repeatRaw === undefined ? 1 : Number(repeatRaw);
  const repeat = Number.isNaN(repeatParsed) || repeatParsed < 1 ? 1 : Math.floor(repeatParsed);

  const modelIds = modelFilter ? modelFilter.split(',').map((id) => id.trim()) : undefined;
  const models = modelIds ? MODELS.filter((m) => modelIds.includes(m.id)) : MODELS;

  const profileIds = profileFilter ? profileFilter.split(',').map((id) => id.trim()) : undefined;
  let profiles: AgentProfile[];
  try {
    profiles = getProfiles(profileIds);
  } catch (err) {
    console.error(String(err));
    process.exit(0);
  }

  if (models.length === 0) {
    console.error(`No model matched --model ${modelFilter}`);
    process.exit(0);
  }

  const records = await runProfiles(models, profiles, { caseId: caseFilter, repeat, runner });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsDir = new URL(`../results/${timestamp}/`, import.meta.url);
  mkdirSync(resultsDir, { recursive: true });

  writeRaw(resultsDir, records);
  writeScores(resultsDir, records);

  for (const m of models) {
    for (const profile of profiles) {
      const group = records.filter((r) => r.model === m.id && r.profile === profile.id);
      if (group.length === 0) continue;
      const ran = group.filter((r) => !r.error).length;
      const errored = group.length - ran;
      const assertionsPassed = group.reduce((n, r) => n + r.scores.filter((s) => s.passed).length, 0);
      const assertionsTotal = group.reduce((n, r) => n + r.scores.length, 0);
      console.log(
        `${m.id} / ${profile.id}: ${ran}/${group.length} runs ran, ${errored} errored, ` +
          `${assertionsPassed}/${assertionsTotal} assertions passed`,
      );
    }
  }

  console.log(`Results written to ${new URL('.', resultsDir).pathname}`);
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
