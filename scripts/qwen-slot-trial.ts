// Single-turn trial adapter. Importing this module performs no requests or commands.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { OpenAI } from 'openai';
import {
  runSlotTrial, validateSlotTrialOptions,
  type MemorySampler, type PreflightInfo, type SlotTrialOptions,
  type TrialRequest, type TrialStreamChunk, type TrialTransport,
} from '../src/slot-trial.js';
import type { MockMap } from '../src/mock-engine.js';
import { buildP1Fixtures } from '../src/slot-trial-fixtures.js';

export interface CliArgs {
  profile: string;
  baseUrl: string;
  expectedSlots: number;
  expectedContextPerSlot: number;
  maxConcurrency: number;
  maxRequests: number;
  durationBudgetMs: number;
  floorHostMib: number;
  floorDeviceMib: number;
  hostMemoryCommand?: string;
  deviceBudgetCommand?: string;
  memoryIntervalMilliseconds: number;
  memorySampleTimeoutMilliseconds: number;
  requestsFile: string;
  outputDir: string;
}

export function parseArgs(argumentsList: string[]): CliArgs {
  const allowed = new Set([
    '--profile', '--base-url', '--expected-slots', '--expected-context-per-slot',
    '--maximum-concurrency', '--maximum-requests', '--duration-budget-ms',
    '--floor-host-mib', '--floor-device-mib', '--host-memory-command', '--device-budget-command',
    '--memory-interval-ms', '--memory-sample-timeout-ms', '--requests-file', '--output',
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!allowed.has(flag)) throw new Error(`unknown flag: ${flag}`);
    if (values.has(flag) || !value?.trim() || value.startsWith('--')) throw new Error(`missing or duplicate value for ${flag}`);
    values.set(flag, value);
  }
  function required(flag: string): string {
    const value = values.get(flag);
    if (value === undefined) throw new Error(`required flag: ${flag}`);
    return value;
  }
  function number(flag: string, fallback?: number): number {
    const value = values.get(flag);
    if (value === undefined && fallback !== undefined) return fallback;
    const parsed = parseMemoryReading(required(flag));
    if (parsed === null || parsed <= 0) throw new Error(`${flag} must be a positive finite number`);
    return parsed;
  }
  const baseUrl = required('--base-url').replace(/\/$/, '');
  const address = new URL(baseUrl);
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash || address.pathname !== '/v1') {
    throw new Error('--base-url must be a direct HTTP endpoint ending in /v1, without credentials, query or fragment');
  }
  const hostMemoryCommand = values.get('--host-memory-command');
  const deviceBudgetCommand = values.get('--device-budget-command');
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(address.hostname) && (!hostMemoryCommand || !deviceBudgetCommand)) {
    throw new Error('remote endpoints require --host-memory-command and --device-budget-command targeting the serving host');
  }
  return {
    profile: required('--profile'), baseUrl,
    expectedSlots: number('--expected-slots'), expectedContextPerSlot: number('--expected-context-per-slot'),
    maxConcurrency: number('--maximum-concurrency'), maxRequests: number('--maximum-requests'), durationBudgetMs: number('--duration-budget-ms'),
    floorHostMib: number('--floor-host-mib'), floorDeviceMib: number('--floor-device-mib'),
    memoryIntervalMilliseconds: number('--memory-interval-ms', 5000),
    memorySampleTimeoutMilliseconds: number('--memory-sample-timeout-ms', 5000),
    hostMemoryCommand, deviceBudgetCommand,
    requestsFile: required('--requests-file'), outputDir: required('--output'),
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Pinned b10621: default_generation_settings.n_ctx and slots[].n_ctx are per-slot. */
export function parsePreflight(properties: unknown, slotRecords: unknown): PreflightInfo {
  if (!object(properties) || !Number.isSafeInteger(properties.total_slots) || Number(properties.total_slots) < 1 || !Array.isArray(slotRecords) || slotRecords.length !== properties.total_slots) {
    throw new Error('preflight slots missing or inconsistent');
  }
  const defaults = properties.default_generation_settings;
  if (!object(defaults) || !Number.isSafeInteger(defaults.n_ctx) || Number(defaults.n_ctx) <= 0) throw new Error('preflight nested context missing');
  const identifiers = new Set<number>();
  for (const slot of slotRecords) {
    if (!object(slot) || slot.n_ctx !== defaults.n_ctx) throw new Error('preflight per-slot context mismatch');
    if (!Number.isSafeInteger(slot.id) || Number(slot.id) < 0 || identifiers.has(Number(slot.id))) throw new Error('preflight invalid slot identifiers');
    identifiers.add(Number(slot.id));
    if (slot.is_processing !== false) throw new Error('preflight slot busy or processing state unknown');
  }
  return {
    slots: Number(properties.total_slots), contextPerSlot: Number(defaults.n_ctx),
    modelPath: typeof properties.model_path === 'string' ? properties.model_path : null,
    // These are not inferred from model aliases or unrelated attention fields.
    attentionCacheType: null,
    kvUnified: typeof properties.kv_unified === 'boolean' ? properties.kv_unified : null,
  };
}

export function parseRequests(definitions: unknown): TrialRequest[] {
  if (!Array.isArray(definitions)) throw new Error('requests file must be an array');
  return definitions.map((definition) => {
    if (!object(definition)) throw new Error('each request must be an object');
    const fields = new Set(['requestIdentifier', 'workload', 'cacheState', 'messages', 'tools', 'mocks', 'foreignMarkers', 'ownMarker', 'maxOutputTokens', 'expectedToolCalls', 'expectedContent', 'expectedJson', 'cancelAfterDelta', 'cancelAfterMilliseconds', 'temperature', 'topP', 'seed', 'responseFormat']);
    for (const field of Object.keys(definition)) if (!fields.has(field)) throw new Error(`unknown request field: ${field}`);
    const { mocks, ...request } = definition;
    if (mocks !== undefined && !object(mocks)) throw new Error('mocks must contain declarative JSON results');
    if ('createMocks' in request) throw new Error('requests files cannot supply executable factories');
    return {
      ...request,
      createMocks: (): MockMap => {
        const results = structuredClone(mocks ?? {});
        return Object.fromEntries(Object.entries(results).map(([name, result]) => [name, () => structuredClone(result)]));
      },
    } as unknown as TrialRequest;
  });
}

export function makeTransport(baseUrl: string, fetchImplementation: typeof fetch = fetch): TrialTransport {
  const client = new OpenAI({
    baseURL: baseUrl, apiKey: 'trial-no-key', maxRetries: 0,
    fetch: (input, initialization) => fetchImplementation(input, { ...initialization, redirect: 'error' }),
  });
  return {
    async preflight(signal?: AbortSignal): Promise<PreflightInfo> {
      const responses: unknown[] = [];
      for (const path of ['/props', '/slots']) {
        const response = await fetchImplementation(`${new URL(baseUrl).origin}${path}`, { signal, redirect: 'error' });
        if (!response.ok) throw new Error(`preflight ${path}: HTTP ${response.status}`);
        responses.push(await response.json());
      }
      return parsePreflight(responses[0], responses[1]);
    },
    async stream(payload, signal) {
      const { data, response } = await client.chat.completions.create({
        model: 'slot-trial',
        messages: payload.messages as OpenAI.ChatCompletionMessageParam[],
        tools: payload.tools.length ? payload.tools as OpenAI.ChatCompletionTool[] : undefined,
        max_tokens: payload.maxOutputTokens, temperature: payload.temperature, top_p: payload.topP,
        seed: payload.seed, response_format: payload.responseFormat,
        stream: true, stream_options: { include_usage: true },
      }, { signal }).withResponse();
      return { status: response.status, chunks: data as AsyncIterable<TrialStreamChunk> };
    },
  };
}

/** A single decimal reading in mebibytes. No truncation, multiple lines or unit guessing. */
export function parseMemoryReading(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value <= Number.MAX_SAFE_INTEGER ? value : null;
}

/** Text vulkaninfo only. Require exactly one Intel B580 and complete DEVICE_LOCAL heap readings. */
export function parseIntelDeviceBudget(text: string): number | null {
  const sections = text.split(/^\s*VkPhysicalDeviceProperties:\s*$/m).slice(1);
  const matching = sections.filter((section) => /^\s*deviceName\s*=.*Intel.*\bB580\b/im.test(section));
  if (matching.length !== 1 || !/^\s*vendorID\s*=\s*0x8086\s*$/im.test(matching[0])) return null;
  const heaps = matching[0].split(/^\s*memoryHeaps\[\d+\]:\s*$/m).slice(1);
  let total = 0;
  let localHeaps = 0;
  for (const section of heaps) {
    const heap = section.split(/^\s*(?:memoryTypes\[|Vk|GPU\d+:)/m)[0];
    if (!/^\s*(?:VK_)?MEMORY_HEAP_DEVICE_LOCAL_BIT\s*$/m.test(heap)) continue;
    localHeaps += 1;
    const budgets = [...heap.matchAll(/^\s*budget\s*=\s*(\d+)(?:\s+\([^\r\n]*\))?\s*$/gm)];
    const usages = [...heap.matchAll(/^\s*usage\s*=\s*(\d+)(?:\s+\([^\r\n]*\))?\s*$/gm)];
    if (budgets.length !== 1 || usages.length !== 1) return null;
    const budget = Number(budgets[0][1]);
    const usage = Number(usages[0][1]);
    if (!Number.isSafeInteger(budget) || !Number.isSafeInteger(usage)) return null;
    total += Math.max(0, budget - usage);
  }
  return localHeaps ? total / (1024 * 1024) : null;
}

type MemoryCommand = (command: string, signal?: AbortSignal) => Promise<string>;

function runMemoryCommand(command: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('bash', ['-c', command], { signal, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export function makeMemorySampler(configuration: CliArgs, execute: MemoryCommand = runMemoryCommand): MemorySampler {
  return async (signal) => {
    const [host, device] = await Promise.all([
      configuration.hostMemoryCommand ? execute(configuration.hostMemoryCommand, signal).catch(() => '') : Promise.resolve(readFileSync('/proc/meminfo', 'utf8')),
      execute(configuration.deviceBudgetCommand ?? 'exec vulkaninfo', signal).catch(() => ''),
    ]);
    const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(host);
    return {
      takenAtMilliseconds: performance.now(),
      hostAvailableMebibytes: available ? Number(available[1]) / 1024 : parseMemoryReading(host),
      freshProcessDeviceLocalBudgetMebibytes: parseMemoryReading(device) ?? parseIntelDeviceBudget(device),
    };
  };
}

/** Effects can be injected for offline command tests. The output directory must be new. */
export async function runCommand(configuration: CliArgs, definitions: unknown, effects?: { transport: TrialTransport; memorySampler: MemorySampler }): Promise<number> {
  const options: SlotTrialOptions = {
    transport: effects?.transport ?? makeTransport(configuration.baseUrl),
    memorySampler: effects?.memorySampler ?? makeMemorySampler(configuration),
    profileLabel: configuration.profile,
    expectedSlots: configuration.expectedSlots, expectedContextPerSlot: configuration.expectedContextPerSlot,
    maxConcurrency: configuration.maxConcurrency, maxRequests: configuration.maxRequests, durationBudgetMs: configuration.durationBudgetMs,
    memoryIntervalMilliseconds: configuration.memoryIntervalMilliseconds,
    memorySampleTimeoutMilliseconds: configuration.memorySampleTimeoutMilliseconds,
    memoryFloors: { hostAvailableMebibytesMinimum: configuration.floorHostMib, freshProcessDeviceLocalBudgetMebibytesMinimum: configuration.floorDeviceMib },
    requests: parseRequests(definitions),
  };
  validateSlotTrialOptions(options);
  mkdirSync(dirname(configuration.outputDir), { recursive: true });
  mkdirSync(configuration.outputDir);
  function writeJson(name: string, value: unknown): void {
    writeFileSync(join(configuration.outputDir, name), JSON.stringify(value, null, 2) + '\n');
  }
  function append(name: string, value: unknown): void {
    appendFileSync(join(configuration.outputDir, name), JSON.stringify(value) + '\n');
  }
  const startedAt = new Date().toISOString();
  writeJson('environment.json', { startedAt, clock: 'performance.now', preflight: null });
  writeJson('profile.json', configuration);
  writeJson('summary.json', { successful: false, state: 'running', requested: options.requests.length });
  for (const definition of definitions as unknown[]) append('requests.jsonl', definition);
  options.onPreflight = (preflight) => writeJson('environment.json', { startedAt, clock: 'performance.now', preflight });
  options.onMemorySample = (sample) => append('memory-samples.jsonl', sample);
  options.onDelta = (delta) => append('deltas.jsonl', delta);
  options.onSample = (sample) => {
    append('responses.jsonl', sample);
    console.log(`${sample.requestIdentifier}: ${sample.outcome}`);
  };
  try {
    const report = await runSlotTrial(options);
    writeJson('validation.json', { preflight: report.preflight, preflightMismatchReasons: report.preflightMismatchReasons, safetyBreaches: report.safetyBreaches, abortedBeforeRequests: report.abortedBeforeRequests });
    writeJson('summary.json', { successful: report.successful, outcomeCounts: report.outcomeCounts, latencySummaries: report.latencySummaries, completedTokensPerSecond: report.completedTokensPerSecond, durationBudgetExceeded: report.durationBudgetExceeded });
    return report.successful ? 0 : 1;
  } catch (error) {
    writeJson('summary.json', { successful: false, state: 'failed', error: String(error) });
    throw error;
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === '--prepare-p1-fixtures') {
    if (process.argv.length !== 6 || process.argv[4] !== '--output') throw new Error('usage: --prepare-p1-fixtures <murmur8-source-root> --output <new-directory>');
    prepareP1Fixtures(process.argv[3], process.argv[5]);
    return;
  }
  const configuration = parseArgs(process.argv.slice(2));
  const definitions: unknown = JSON.parse(readFileSync(configuration.requestsFile, 'utf8'));
  process.exitCode = await runCommand(configuration, definitions);
}

export function prepareP1Fixtures(sourceRoot: string, outputDirectory: string): void {
  const bundle = buildP1Fixtures(sourceRoot);
  mkdirSync(dirname(outputDirectory), { recursive: true });
  mkdirSync(outputDirectory);
  writeFileSync(join(outputDirectory, 'requests.json'), JSON.stringify(bundle.requests, null, 2) + '\n');
  writeFileSync(join(outputDirectory, 'sources.json'), JSON.stringify(bundle.evidence, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => { console.error(String(error)); process.exitCode = 1; });
}
