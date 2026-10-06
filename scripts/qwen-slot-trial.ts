// qwen-slot-trial — CLI adapter for the bounded two-slot trial runner (src/slot-trial.ts).
//
// Direct-endpoint only: it talks to an ALREADY-RUNNING llama-server via its
// OpenAI-compatible API. It never starts, stops, downloads or changes a model.
// Automatic HTTP retries are disabled (maxRetries: 0) and there is no cloud
// fallback — a failed request is recorded as failed, not retried elsewhere.
//
// Usage (all flags as per the trial plan):
//   npx tsx scripts/qwen-slot-trial.ts \
//     --profile P3 --base-url http://frame:8289/v1 \
//     --expected-slots 2 --expected-context-per-slot 24576 \
//     --maximum-concurrency 2 --maximum-requests 60 \
//     --duration-budget-ms 5400000 \
//     --floor-host-mib 2048 --floor-device-mib 1024 \
//     --host-memory-command "ssh frame 'awk \"/MemAvailable/ {print int(\\\\\$2/1024)}\" /proc/meminfo'" \
//     --device-budget-command "<shell one-liner printing free device-local Vulkan budget in MiB on the target>" \
//     --requests-file trial-requests.json \
//     --output results/qwen35-two-slot-trial/<run-identifier>
//
// Without the *-command flags the sampler reads the LOCAL machine — only correct
// when the runner runs on the target host itself.
//
// The requests file is a JSON array of request definitions (see REQUESTS FILE
// FORMAT in the README): explicit request identifiers, workloads, cache-state
// labels, per-request mutable messages/tools, deterministic mock RESULTS as
// plain JSON (wrapped here into functions — no production tool credentials),
// foreign/own markers, output budgets and optional cancellation points.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { OpenAI } from 'openai';
import {
  runSlotTrial,
  MAX_TRIAL_CONCURRENCY,
  type MemorySample,
  type MemorySampler,
  type PreflightInfo,
  type TrialRequest,
  type TrialStream,
  type TrialStreamChunk,
  type TrialTransport,
} from '../src/slot-trial.js';
import type { MockMap } from '../src/mock-engine.js';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface CliArgs {
  profile: string;
  baseUrl: string;
  expectedSlots?: number;
  expectedContextPerSlot?: number;
  maxConcurrency: number;
  maxRequests: number;
  durationBudgetMs: number;
  floorHostMib?: number;
  floorDeviceMib?: number;
  /** Shell command printing host-available MiB (for sampling a remote target, e.g. `ssh frame ...`). */
  hostMemoryCommand?: string;
  /** Shell command printing fresh-process device-local budget MiB on the target. */
  deviceBudgetCommand?: string;
  requestsFile: string;
  outputDir: string;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

export function parseArgs(argv: string[]): CliArgs {
  const profile = flagValue(argv, '--profile');
  const baseUrl = flagValue(argv, '--base-url');
  const requestsFile = flagValue(argv, '--requests-file');
  const outputDir = flagValue(argv, '--output');
  const maxConcurrency = Number(flagValue(argv, '--maximum-concurrency') ?? MAX_TRIAL_CONCURRENCY);
  if (!profile || !baseUrl || !requestsFile || !outputDir) {
    throw new Error('missing required flags: --profile, --base-url, --requests-file, --output');
  }
  if (!(maxConcurrency >= 1) || maxConcurrency > MAX_TRIAL_CONCURRENCY) {
    throw new Error(`--maximum-concurrency must be between 1 and ${String(MAX_TRIAL_CONCURRENCY)}`);
  }
  const numberFlag = (flag: string): number | undefined => {
    const raw = flagValue(argv, flag);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${flag} is not a number: ${raw}`);
    return value;
  };
  const maxRequests = numberFlag('--maximum-requests');
  const durationBudgetMs = numberFlag('--duration-budget-ms');
  if (maxRequests === undefined || !(maxRequests >= 1)) throw new Error('--maximum-requests is required');
  if (durationBudgetMs === undefined || !(durationBudgetMs >= 1)) throw new Error('--duration-budget-ms is required');
  return {
    profile,
    baseUrl: baseUrl.replace(/\/$/, ''),
    expectedSlots: numberFlag('--expected-slots'),
    expectedContextPerSlot: numberFlag('--expected-context-per-slot'),
    maxConcurrency,
    maxRequests,
    durationBudgetMs,
    floorHostMib: numberFlag('--floor-host-mib'),
    floorDeviceMib: numberFlag('--floor-device-mib'),
    hostMemoryCommand: flagValue(argv, '--host-memory-command'),
    deviceBudgetCommand: flagValue(argv, '--device-budget-command'),
    requestsFile,
    outputDir,
  };
}

// ---------------------------------------------------------------------------
// Requests file
// ---------------------------------------------------------------------------

interface RequestFileEntry {
  requestIdentifier: string;
  workload: 'title' | 'fill' | 'portal' | 'isolation';
  cacheState: 'cold' | 'warm';
  messages: unknown[];
  tools?: unknown[];
  /** Deterministic mock RESULTS (plain JSON), wrapped into functions here. No live tools, no credentials. */
  mocks?: Record<string, unknown>;
  expectedToolCalls?: Array<{ name: string; arguments?: Record<string, unknown> }>;
  foreignMarkers: string[];
  ownMarker?: string;
  maxOutputTokens: number;
  cancelAfterDelta?: number;
}

function loadRequests(file: string): TrialRequest[] {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`requests file must be a JSON array: ${file}`);
  return (parsed as RequestFileEntry[]).map((entry) => {
    const mocks: MockMap = {};
    for (const [name, result] of Object.entries(entry.mocks ?? {})) {
      mocks[name] = () => result;
    }
    return {
      requestIdentifier: entry.requestIdentifier,
      workload: entry.workload,
      cacheState: entry.cacheState,
      messages: entry.messages,
      tools: entry.tools,
      mocks,
      expectedToolCalls: entry.expectedToolCalls,
      foreignMarkers: entry.foreignMarkers,
      ownMarker: entry.ownMarker,
      maxOutputTokens: entry.maxOutputTokens,
      cancelAfterDelta: entry.cancelAfterDelta,
    };
  });
}

// ---------------------------------------------------------------------------
// Real transport (OpenAI SDK, streaming, no retries, no fallback)
// ---------------------------------------------------------------------------

function makeTransport(baseUrl: string): TrialTransport {
  const client = new OpenAI({ baseURL: baseUrl, apiKey: 'trial-no-key', maxRetries: 0 });

  return {
    async preflight(): Promise<PreflightInfo> {
      // llama.cpp serves /props next to /v1; defensive mapping — unknown fields stay null
      // and only FAIL the preflight when an --expected-* flag was given for them.
      const response = await fetch(`${new URL(baseUrl).origin}/props`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`preflight: GET /props returned HTTP ${String(response.status)}`);
      const props: any = await response.json();
      const slots = typeof props.total_slots === 'number' ? props.total_slots : typeof props.parallel === 'number' ? props.parallel : null;
      const contextPerSlot =
        typeof props.slot_n_ctx === 'number'
          ? props.slot_n_ctx
          : typeof props.n_ctx === 'number' && slots && slots > 0
            ? Math.floor(props.n_ctx / slots)
            : null;
      return {
        slots,
        contextPerSlot,
        modelPath: typeof props.model_path === 'string' ? props.model_path : (typeof props.model_alias === 'string' ? props.model_alias : null),
        attentionCacheType: typeof props.attention_type === 'string' ? props.attention_type : (typeof props.kv_type === 'string' ? props.kv_type : null),
        kvUnified: typeof props.kv_unified === 'boolean' ? props.kv_unified : null,
      };
    },

    async stream(payload, signal): Promise<TrialStream> {
      try {
        const stream = await client.chat.completions.create(
          {
            model: 'slot-trial', // llama.cpp ignores the model name; one model per server
            messages: payload.messages as any,
            tools: payload.tools.length > 0 ? (payload.tools as any) : undefined,
            max_tokens: payload.maxOutputTokens,
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal },
        );
        return { status: 200, chunks: stream as AsyncIterable<TrialStreamChunk> };
      } catch (error: any) {
        // The abort we caused ourselves must not look like a transport failure.
        if (signal.aborted) return { status: null, chunks: emptyAsync() };
        throw error;
      }
    },
  };
}

async function* emptyAsync(): AsyncIterable<TrialStreamChunk> {
  // intentionally empty
}

// ---------------------------------------------------------------------------
// Memory sampler (host MemAvailable + fresh-process Vulkan device-local budget)
// ---------------------------------------------------------------------------

function readHostAvailableMebibytes(): number | null {
  try {
    for (const line of readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const match = /^MemAvailable:\s+(\d+)\s+kB$/.exec(line);
      if (match) return Math.round(Number(match[1]) / 1024);
    }
  } catch {
    /* no /proc — the floor for that field cannot be checked */
  }
  return null;
}

function runVulkaninfo(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('vulkaninfo', args, { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** Fresh-process device-local budget (MiB) for the Intel device, via VK_EXT_memory_budget. */
async function readDeviceLocalBudgetMebibytes(): Promise<number | null> {
  // Preferred path: vulkaninfo --json (when the loader can emit it).
  try {
    const info: any = JSON.parse(await runVulkaninfo(['--json']));
    for (const device of Object.values(info?.components ?? {}) as any[]) {
      const budget = device?.['VkDeviceMemoryBudgetPropertiesEXT'];
      if (!budget) continue;
      const heaps: any[] = device?.['VkPhysicalDeviceMemoryProperties']?.memoryHeaps ?? [];
      let total = 0;
      for (let index = 0; index < heaps.length; index += 1) {
        if (!(heaps[index]?.propertyFlags ?? []).includes('VK_MEMORY_HEAP_DEVICE_LOCAL_BIT')) continue;
        const budgetHeap = Number(budget?.heapBudget?.[index]);
        const usage = Number(budget?.heapUsage?.[index]);
        if (Number.isFinite(budgetHeap) && Number.isFinite(usage)) total += budgetHeap - usage;
      }
      if (total > 0) return Math.round(total / (1024 * 1024));
    }
  } catch {
    /* fall through to the text-output parser */
  }
  // Fallback: text vulkaninfo. Split into per-device sections; for the Intel device,
  // sum (budget - usage) over DEVICE_LOCAL heaps. A zero budget line means the
  // extension did not report that heap — skip it.
  try {
    const text = await runVulkaninfo([]);
    const sections = text.split(/^VkPhysicalDeviceProperties:/m);
    for (const section of sections.slice(1)) {
      if (!/deviceName\s*=.*Intel/i.test(section)) continue;
      let total = 0;
      for (const heap of section.split(/^memoryHeaps\[\d+\]:/m).slice(1)) {
        if (!heap.includes('MEMORY_HEAP_DEVICE_LOCAL_BIT')) continue;
        const budget = /budget\s*=\s*(\d+)/.exec(heap);
        const usage = /usage\s*=\s*(\d+)/.exec(heap);
        if (budget && Number(budget[1]) > 0) total += Number(budget[1]) - Number(usage?.[1] ?? 0);
      }
      if (total > 0) return Math.round(total / (1024 * 1024));
    }
  } catch {
    /* vulkaninfo missing or unparsable — the floor for that field cannot be checked */
  }
  return null;
}

function runShellInt(command: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('bash', ['-c', command], { timeout: 30_000 }, (error, stdout) => {
      if (error) resolve(null);
      else {
        const value = Number.parseInt(stdout.trim(), 10);
        resolve(Number.isFinite(value) ? value : null);
      }
    });
  });
}

function makeMemorySampler(hostCommand?: string, deviceCommand?: string): MemorySampler {
  return async (): Promise<MemorySample> => ({
    takenAtMilliseconds: Date.now(),
    hostAvailableMebibytes: hostCommand ? await runShellInt(hostCommand) : readHostAvailableMebibytes(),
    freshProcessDeviceLocalBudgetMebibytes: deviceCommand ? await runShellInt(deviceCommand) : await readDeviceLocalBudgetMebibytes(),
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.maxConcurrency > MAX_TRIAL_CONCURRENCY) {
    throw new Error(`--maximum-concurrency is bounded at ${String(MAX_TRIAL_CONCURRENCY)} for this trial`);
  }
  let requests = loadRequests(args.requestsFile);
  if (requests.length > args.maxRequests) {
    console.log(`requests file holds ${String(requests.length)} requests; bounding to --maximum-requests ${String(args.maxRequests)}`);
    requests = requests.slice(0, args.maxRequests);
  }

  const floors: Record<string, number> = {};
  if (args.floorHostMib !== undefined) floors.hostAvailableMebibytesMinimum = args.floorHostMib;
  if (args.floorDeviceMib !== undefined) floors.freshProcessDeviceLocalBudgetMebibytes = args.floorDeviceMib;

  const memorySampler = makeMemorySampler(args.hostMemoryCommand, args.deviceBudgetCommand);
  const report = await runSlotTrial({
    transport: makeTransport(args.baseUrl),
    profileLabel: args.profile,
    memorySampler,
    memoryFloors: floors,
    expectedSlots: args.expectedSlots,
    expectedContextPerSlot: args.expectedContextPerSlot,
    maxConcurrency: args.maxConcurrency,
    maxRequests: args.maxRequests,
    durationBudgetMs: args.durationBudgetMs,
    requests,
  });

  mkdirSync(args.outputDir, { recursive: true });
  const writeJsonl = (file: string, rows: unknown[]): void => {
    writeFileSync(join(args.outputDir, file), rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''));
  };
  writeFileSync(join(args.outputDir, 'environment.json'), JSON.stringify(await memorySampler(), null, 2) + '\n');
  writeFileSync(join(args.outputDir, 'profile.json'), JSON.stringify({ ...args, transport: 'openai-sdk-streaming-no-retries' }, null, 2) + '\n');
  writeJsonl('requests.jsonl', requests);
  writeJsonl('responses.jsonl', report.samples);
  writeJsonl('memory-samples.jsonl', report.memorySamples);
  writeFileSync(
    join(args.outputDir, 'validation.json'),
    JSON.stringify({ preflight: report.preflight, preflightMismatchReasons: report.preflightMismatchReasons, safetyBreaches: report.safetyBreaches, abortedBeforeRequests: report.abortedBeforeRequests }, null, 2) + '\n',
  );
  writeFileSync(join(args.outputDir, 'summary.json'), JSON.stringify({ latencySummaries: report.latencySummaries, completedTokensPerSecond: report.completedTokensPerSecond, durationBudgetExceeded: report.durationBudgetExceeded }, null, 2) + '\n');

  console.log(`preflight aborted: ${String(report.abortedBeforeRequests)}; samples: ${String(report.samples.length)}; safety breaches: ${String(report.safetyBreaches.length)}`);
  for (const line of [...report.preflightMismatchReasons, ...report.safetyBreaches]) console.log(`  ! ${line}`);
  for (const sample of report.samples) {
    if (sample.validationErrors.length > 0) console.log(`  ! ${sample.requestIdentifier}: ${sample.validationErrors.join('; ')}`);
  }
  // Non-zero exit when any correctness/safety gate failed so the driver can stop.
  const failed =
    report.abortedBeforeRequests ||
    report.safetyBreaches.length > 0 ||
    report.samples.some((sample) => sample.foreignMarkers.length > 0 || sample.validationErrors.length > 0);
  process.exitCode = failed ? 1 : 0;
}

await main();
