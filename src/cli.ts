// model-eval CLI. `parseArgs` is a pure function (unit-tested without touching
// frame/HF). `runCommand` composes the resolver/serve/bench/write steps with
// every side effect injected via `deps`, so the orchestration is testable with
// fakes; `main` wires the real implementations and dispatches run/serve/stop.

import { mkdirSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolveGguf } from './hf.js';
import { nextFreePort, serveOnFrame, stopOnFrame, waitReady } from './frame.js';
import { ephemeralModel, findModel, MODELS, type ModelConfig } from './models.js';
import { getProfiles, type AgentProfile } from './profile.js';
import { runProfiles, writeRaw, writeScores, type RawRecord } from './run.js';
import { writeSummary } from './summary.js';
import { writeBundle } from './bundle.js';
import { saveBaseline, loadBaseline } from './baseline-cache.js';
import { appendRegistry } from './registry.js';

export interface ParsedArgs {
  command: 'run' | 'serve' | 'stop';
  hfSpec?: string;
  profiles?: string[];
  caseId?: string;
  baseline?: string;
  keep: boolean;
  port?: number;
}

const USAGE =
  'usage: model-eval run <hfSpec> [--profile a,b] [--case id] [--baseline haiku] [--keep]\n' +
  '       model-eval serve <hfSpec> [--port N]\n' +
  '       model-eval stop --port N';

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0];
  if (command !== 'run' && command !== 'serve' && command !== 'stop') {
    throw new Error(`unknown command: ${command ?? '(none)'}\n${USAGE}`);
  }

  const keep = argv.includes('--keep');
  const portRaw = flagValue(argv, '--port');
  const port = portRaw === undefined ? undefined : Number(portRaw);
  const profileRaw = flagValue(argv, '--profile');
  const profiles = profileRaw === undefined ? undefined : profileRaw.split(',').map((p) => p.trim());
  const caseId = flagValue(argv, '--case');
  const baseline = flagValue(argv, '--baseline');

  if (command === 'run' || command === 'serve') {
    const hfSpec = argv[1];
    if (!hfSpec || hfSpec.startsWith('--')) {
      throw new Error(`${command} requires a HuggingFace repo spec`);
    }
    return { command, hfSpec, profiles, caseId, baseline, keep, port };
  }

  // stop
  return { command, keep, port };
}

/** Injectable side effects for `runCommand` (bound to real impls by `main`). */
export interface RunDeps {
  resolveGguf: (spec: string, token?: string) => Promise<{ repo: string; file: string }>;
  serveOnFrame: (arg: { repo?: string; file: string; port: number }) => Promise<{ port: number; baseURL: string }>;
  waitReady: (baseURL: string) => Promise<boolean>;
  stopOnFrame: (port: number) => Promise<void>;
  runProfiles: (
    models: ModelConfig[],
    profiles: AgentProfile[],
    opts: { caseId?: string },
  ) => Promise<RawRecord[]>;
  writeRaw: (dir: URL | string, records: RawRecord[]) => void;
  writeScores: (dir: URL | string, records: RawRecord[]) => void;
  writeSummary: (dir: URL | string, records: RawRecord[]) => void;
  writeBundle: (dir: URL | string, records: RawRecord[], profiles: AgentProfile[]) => void;
  saveBaseline: (dir: URL | string, id: string, records: RawRecord[]) => void;
  loadBaseline: (dir: URL | string, id: string) => RawRecord[] | null;
  appendRegistry: (
    records: RawRecord[],
    opts: { gitSha: string; timestamp: string; registryPath: URL | string; cachedIds?: Set<string> },
  ) => void;
  now?: () => string;
  resultsBase?: URL | string;
  baselinesDir?: URL | string;
  registryPath?: URL | string;
  gitSha?: string;
}

type BaselineMode =
  | { mode: 'none' }
  | { mode: 'live'; id: string }
  | { mode: 'cached'; id: string };

/** Interpret the raw --baseline arg into a mode + baseline id. */
function parseBaseline(raw: string): BaselineMode {
  if (raw === 'none') return { mode: 'none' };
  if (raw.startsWith('cached:')) return { mode: 'cached', id: raw.slice(7) };
  return { mode: 'live', id: raw };
}

function defaultNow(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function resultsSubdir(base: URL | string, timestamp: string): URL {
  if (typeof base === 'string') {
    const dir = base.endsWith('/') ? base : `${base}/`;
    return new URL(`${timestamp}/`, pathToFileURL(dir));
  }
  return new URL(`${timestamp}/`, base);
}

/**
 * Resolve a GGUF, serve it on frame, benchmark the candidate against the
 * baseline across the selected profiles, write the four data artifacts, then
 * tear the server down (unless `--keep`). Every side effect comes from `deps`.
 */
export async function runCommand(args: ParsedArgs, deps: RunDeps): Promise<void> {
  if (!args.hfSpec) throw new Error('run requires a HuggingFace repo spec');

  const baselinesDir = deps.baselinesDir ?? new URL('../baselines/', import.meta.url);
  const registryPath = deps.registryPath ?? new URL('../registry.jsonl', import.meta.url);
  const gitSha = deps.gitSha ?? 'unknown';
  const baseline = parseBaseline(args.baseline ?? 'qwen-agentic');

  // A candidate that names an already-registered local model (e.g. a tuned GGUF
  // hand-served on frame) is used directly — we neither resolve it from HF nor
  // start/stop its server. HF specs contain a '/', so they never collide with a
  // registry id slug.
  const registeredCandidate = MODELS.find((m) => m.id === args.hfSpec && m.kind === 'local');

  let candidate: ModelConfig;
  let servedPort: number | undefined;
  if (registeredCandidate) {
    candidate = registeredCandidate;
  } else {
    const token = process.env.HF_TOKEN;
    const { repo, file } = await deps.resolveGguf(args.hfSpec, token);
    const served = await deps.serveOnFrame({ repo, file, port: nextFreePort([]) });
    servedPort = served.port;
    candidate = ephemeralModel(served.baseURL, file);
  }

  try {
    const ready = await deps.waitReady(candidate.baseURL);
    if (!ready) throw new Error(`model server never became ready at ${candidate.baseURL}`);

    const profiles = getProfiles(args.profiles);

    // Only mode 'live' serves and benchmarks the baseline; the pre-existing
    // baseline instance on frame is never started or stopped by us.
    const models = baseline.mode === 'live' ? [candidate, findModel(baseline.id)] : [candidate];
    let records = await deps.runProfiles(models, profiles, { caseId: args.caseId });

    let cachedIds = new Set<string>();
    if (baseline.mode === 'live') {
      const baselineRows = records.filter((r) => r.model === baseline.id);
      deps.saveBaseline(baselinesDir, baseline.id, baselineRows);
    } else if (baseline.mode === 'cached') {
      const cached = deps.loadBaseline(baselinesDir, baseline.id);
      if (cached === null) {
        throw new Error(
          `no cached baseline for ${baseline.id}; run once with --baseline ${baseline.id} first`,
        );
      }
      const profileIds = new Set(profiles.map((p) => p.id));
      const folded = cached.filter(
        (r) => profileIds.has(r.profile) && (!args.caseId || args.caseId === r.caseId),
      );
      records = records.concat(folded);
      cachedIds = new Set([baseline.id]);
    }

    const timestamp = (deps.now ?? defaultNow)();
    const dir = resultsSubdir(deps.resultsBase ?? new URL('../results/', import.meta.url), timestamp);
    mkdirSync(dir, { recursive: true });
    deps.writeRaw(dir, records);
    deps.writeScores(dir, records);
    deps.writeSummary(dir, records);
    deps.writeBundle(dir, records, profiles);
    deps.appendRegistry(records, { gitSha, timestamp, registryPath, cachedIds });
  } finally {
    if (!args.keep && servedPort !== undefined) await deps.stopOnFrame(servedPort);
  }
}

const execFileAsync = promisify(execFile);

/** Real SSH exec: run a command on frame over the tailnet. */
async function sshExec(cmd: string): Promise<string> {
  const host = process.env.FRAME_SSH_HOST ?? 'frame';
  const { stdout } = await execFileAsync('ssh', [host, cmd]);
  return stdout;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'run') {
    let gitSha = 'unknown';
    try {
      gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      gitSha = 'unknown';
    }
    await runCommand(args, {
      resolveGguf: (spec, token) => resolveGguf(spec, token),
      serveOnFrame: (arg) => serveOnFrame(arg, sshExec),
      waitReady: (baseURL) => waitReady(baseURL),
      stopOnFrame: (port) => stopOnFrame(port, sshExec),
      runProfiles,
      writeRaw,
      writeScores,
      writeSummary,
      writeBundle,
      saveBaseline,
      loadBaseline,
      appendRegistry,
      baselinesDir: new URL('../baselines/', import.meta.url),
      registryPath: new URL('../registry.jsonl', import.meta.url),
      gitSha,
    });
    return;
  }

  if (args.command === 'serve') {
    const token = process.env.HF_TOKEN;
    const { repo, file } = await resolveGguf(args.hfSpec!, token);
    const port = args.port ?? nextFreePort([]);
    const { baseURL } = await serveOnFrame({ repo, file, port }, sshExec);
    const ready = await waitReady(baseURL);
    console.log(`serving ${file} on ${baseURL} (ready=${ready})`);
    return;
  }

  // stop
  if (args.port === undefined) throw new Error('stop requires --port');
  await stopOnFrame(args.port, sshExec);
  console.log(`stopped server on port ${args.port}`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
