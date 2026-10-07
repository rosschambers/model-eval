import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as adapter from '../scripts/qwen-slot-trial.js';
import { runSlotTrial, type TrialRequest } from './slot-trial.js';

const directories: string[] = [];
beforeEach(() => {
  function blocked(): never { throw new Error('Network forbidden in adapter tests: inject fetch'); }
  vi.stubGlobal('fetch', blocked);
  vi.spyOn(http, 'request').mockImplementation(blocked);
  vi.spyOn(https, 'request').mockImplementation(blocked);
});
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const flags = ['--profile', 'P1', '--base-url', 'http://127.0.0.1:8289/v1', '--requests-file', 'synthetic.json', '--output', 'unused', '--maximum-concurrency', '1', '--maximum-requests', '2', '--duration-budget-ms', '1000', '--expected-slots', '1', '--expected-context-per-slot', '24576', '--floor-host-mib', '2048', '--floor-device-mib', '1024'];

// Sanitized pinned llama.cpp b10621 shapes: n_ctx here is PER SLOT, not total context.
// No private data. These assert the documented nested shape, not a live server probe.
const properties = { total_slots: 1, model_path: '/synthetic/qwen.gguf', default_generation_settings: { n_ctx: 24576, params: { seed: 4294967295 } } };
const slots = [{ id: 0, n_ctx: 24576, is_processing: false, params: { n_predict: -1 } }];
const vulkan = `GPU0:
VkPhysicalDeviceProperties:
  vendorID = 0x1002
  deviceName = AMD Radeon Graphics
VkPhysicalDeviceMemoryProperties:
  memoryHeaps[0]:
    budget = 9999999999
    usage = 0
    flags: count = 1
      MEMORY_HEAP_DEVICE_LOCAL_BIT
GPU1:
VkPhysicalDeviceProperties:
  vendorID = 0x8086
  deviceName = Intel(R) Arc(TM) B580 Graphics
VkPhysicalDeviceMemoryProperties:
  memoryHeaps[0]:
    size = 12884901888 (0x300000000) (12.00 GiB)
    budget = 2147483648 (0x80000000) (2.00 GiB)
    usage = 1048576 (0x100000) (1.00 MiB)
    flags: count = 1
      MEMORY_HEAP_DEVICE_LOCAL_BIT
  memoryHeaps[1]:
    budget = 9999999999
    usage = 0
    flags:
      None
  memoryTypes[0]:
    heapIndex = 0
    propertyFlags:
      MEMORY_PROPERTY_DEVICE_LOCAL_BIT
`;

const definition = { requestIdentifier: 'one', workload: 'title', cacheState: 'warm', messages: [{ role: 'user', content: 'Synthetic garden conversation' }], foreignMarkers: [], maxOutputTokens: 16, temperature: 0.3, seed: 42 };

describe('trial command adapter', () => {
  it('can be imported offline without executing the command', async () => {
    await expect(import('../scripts/qwen-slot-trial.js')).resolves.toHaveProperty('parseArgs');
  });

  it.each(['--expected-slots', '--expected-context-per-slot', '--floor-host-mib', '--floor-device-mib'])('requires %s', (flag) => {
    const missing = [...flags];
    missing.splice(missing.indexOf(flag), 2);
    expect(() => adapter.parseArgs(missing)).toThrow();
  });

  it('requires explicit remote samplers and rejects misspelled flags', () => {
    const remote = flags.map((value) => value.replace('127.0.0.1', 'frame'));
    expect(() => adapter.parseArgs(remote)).toThrow(/memory.*command|remote/i);
    expect(() => adapter.parseArgs([...flags, '--maximum-concurency', '1'])).toThrow(/unknown/i);
    expect(adapter.parseArgs([...remote, '--host-memory-command', 'synthetic-host', '--device-budget-command', 'synthetic-device'])).toHaveProperty('hostMemoryCommand', 'synthetic-host');
  });

  it('maps nested per-slot context and cross-checks all slot records', async () => {
    const fetcher = vi.fn(async (url: unknown) => new Response(JSON.stringify(String(url).endsWith('/props') ? properties : slots), { status: 200 }));
    const transport = adapter.makeTransport('http://synthetic.invalid/v1', fetcher);
    expect(await transport.preflight()).toMatchObject({ slots: 1, contextPerSlot: 24576, modelPath: '/synthetic/qwen.gguf' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(['http://synthetic.invalid/props', 'http://synthetic.invalid/slots']);
    expect(adapter.parsePreflight({ ...properties, total_slots: 2 }, [...slots, { ...slots[0], id: 1 }]).contextPerSlot).toBe(24576);
    expect(() => adapter.parsePreflight(properties, [{ ...slots[0], n_ctx: 12288 }])).toThrow(/context/i);
    expect(() => adapter.parsePreflight(properties, [{ ...slots[0], is_processing: true }])).toThrow(/busy|processing/i);
    expect(() => adapter.parsePreflight(properties, [])).toThrow(/slots/i);
    expect(() => adapter.parsePreflight({ total_slots: 1, n_ctx: 24576 }, slots)).toThrow(/context/i);
  });

  it.each(['', '2048 garbage', '2048\n4096', 'NaN', 'Infinity', '-1'])('rejects malformed memory output %j', (text) => {
    expect(adapter.parseMemoryReading(text)).toBeNull();
  });

  it('preserves fractional and zero memory readings', () => {
    expect(adapter.parseMemoryReading('2098.25\n')).toBe(2098.25);
    expect(adapter.parseMemoryReading('0')).toBe(0);
  });

  it('parses only Intel B580 device-local heaps with indentation and zero budgets', () => {
    expect(adapter.parseIntelDeviceBudget(vulkan)).toBe(2047);
    expect(adapter.parseIntelDeviceBudget(vulkan.replace('2147483648 (0x80000000)', '0 (0x0)').replace('usage = 1048576', 'usage = 0'))).toBe(0);
    expect(adapter.parseIntelDeviceBudget(vulkan.replace('    usage = 1048576 (0x100000) (1.00 MiB)\n', ''))).toBeNull();
    expect(adapter.parseIntelDeviceBudget(vulkan.replace('B580', 'A770'))).toBeNull();
    expect(adapter.parseIntelDeviceBudget(vulkan + vulkan)).toBeNull();
    expect(adapter.parseIntelDeviceBudget(vulkan.replace('budget = 2147483648', 'budget = nonsense'))).toBeNull();
  });

  it('uses both injected target commands and fails closed on command errors', async () => {
    const configuration = adapter.parseArgs([...flags.map((value) => value.replace('127.0.0.1', 'frame')), '--host-memory-command', 'read-host', '--device-budget-command', 'read-device']);
    const execute = vi.fn(async (command: string) => command === 'read-host' ? 'MemAvailable: 4194304 kB\n' : vulkan);
    expect(await adapter.makeMemorySampler(configuration, execute)()).toMatchObject({ hostAvailableMebibytes: 4096, freshProcessDeviceLocalBudgetMebibytes: 2047 });
    expect(execute.mock.calls.map(([command]) => command).sort()).toEqual(['read-device', 'read-host']);
    expect(await adapter.makeMemorySampler(configuration, async () => { throw new Error('synthetic failure'); })()).toMatchObject({ hostAvailableMebibytes: null, freshProcessDeviceLocalBudgetMebibytes: null });
  });

  it('carries sampling, seed and response_format through the core and real SDK without network', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (url: unknown, initialization?: RequestInit) => {
      if (String(url).endsWith('/props')) return new Response(JSON.stringify(properties));
      if (String(url).endsWith('/slots')) return new Response(JSON.stringify(slots));
      expect(initialization?.redirect).toBe('error');
      bodies.push(JSON.parse(String(initialization?.body)));
      return new Response('data: {"choices":[{"delta":{"content":"{\\"title\\":\\"Water plants\\"}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const responseFormat = { type: 'json_schema', json_schema: { name: 'synthetic', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } } };
    const requests = adapter.parseRequests([{ ...definition, workload: 'fill', temperature: 0, topP: 0.9, responseFormat, expectedJson: { title: 'Water plants' } }]);
    const report = await runSlotTrial({ transport: adapter.makeTransport('http://synthetic.invalid/v1', fetcher), profileLabel: 'P1', maxConcurrency: 1, maxRequests: 1, durationBudgetMs: 1000, requests });
    expect(report.samples[0].outcome).toBe('completed');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ temperature: 0, top_p: 0.9, seed: 42, response_format: responseFormat, max_tokens: 16, stream: true });
  });

  it('never retries failed completions and preserves HTTP status', async () => {
    const fetcher = vi.fn(async () => new Response('{"error":{"message":"synthetic failure"}}', { status: 503 }));
    const transport = adapter.makeTransport('http://synthetic.invalid/v1', fetcher);
    await expect(transport.stream({ requestIdentifier: 'one', messages: [], tools: [], maxOutputTokens: 1 }, new AbortController().signal)).rejects.toHaveProperty('status', 503);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves completed and partial responses incrementally and fails incomplete runs', async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), 'slot-trial-offline-'));
    directories.push(directory);
    const configuration = adapter.parseArgs(flags.map((value) => value === 'unused' ? join(directory, 'result') : value));
    let submissions = 0;
    const pending = adapter.runCommand(configuration, [definition, { ...definition, requestIdentifier: 'two' }], {
      transport: {
        preflight: async () => adapter.parsePreflight(properties, slots),
        stream: async () => ({ status: 200, chunks: { async *[Symbol.asyncIterator]() {
          if (++submissions === 1) yield { choices: [{ delta: { content: 'Garden Planning' }, finish_reason: 'stop' }] };
          else { yield { choices: [{ delta: { content: 'Partial' } }] }; await new Promise(() => {}); }
        } } }),
      },
      memorySampler: async () => ({ takenAtMilliseconds: 0, hostAvailableMebibytes: 4096, freshProcessDeviceLocalBudgetMebibytes: 2048 }),
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(readFileSync(join(configuration.outputDir, 'responses.jsonl'), 'utf8')).toContain('Garden Planning');
    expect(readFileSync(join(configuration.outputDir, 'deltas.jsonl'), 'utf8')).toContain('Partial');
    await vi.advanceTimersByTimeAsync(1001);
    expect(await pending).toBe(1);
    const summary = JSON.parse(readFileSync(join(configuration.outputDir, 'summary.json'), 'utf8'));
    expect(summary.outcomeCounts).toEqual({ total: 2, completed: 1, failed: 1, cancelled: 0, not_started: 0 });
    expect(summary.successful).toBe(false);
    expect(JSON.parse(readFileSync(join(configuration.outputDir, 'environment.json'), 'utf8'))).toHaveProperty('preflight.contextPerSlot', 24576);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps declarative mock results serializable and creates fresh factories', () => {
    const source = [{ ...definition, mocks: { list: { results: [] } } }];
    const requests = adapter.parseRequests(source);
    expect(requests[0].createMocks?.()).not.toBe(requests[0].createMocks?.());
    expect(JSON.stringify(source)).toContain('"results":[]');
  });

  it('rejects unknown request fields rather than silently dropping sampling settings', () => {
    expect(() => adapter.parseRequests([{ ...definition, response_format: { type: 'json_object' } }])).toThrow(/unknown.*response_format/i);
  });

  const sourceRoot = resolve('../../projects/murmur8');
  it.skipIf(!existsSync(join(sourceRoot, 'src/Murmur8.Infrastructure/AI/ai-prompts.json')))('prepares source-checked synthetic title and reminder-fill fixtures without an endpoint', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'slot-trial-fixtures-'));
    directories.push(directory);
    const output = join(directory, 'fixtures');
    adapter.prepareP1Fixtures(sourceRoot, output);
    const definitions = JSON.parse(readFileSync(join(output, 'requests.json'), 'utf8'));
    const prompt = JSON.parse(readFileSync(join(sourceRoot, 'src/Murmur8.Infrastructure/AI/ai-prompts.json'), 'utf8')).AI.TitleGenerationPrompt;
    expect(definitions).toHaveLength(8);
    const title = definitions.find((entry: TrialRequest) => entry.workload === 'title');
    const fill = definitions.find((entry: TrialRequest) => entry.workload === 'fill');
    expect(title.messages[0].content).toBe(prompt);
    expect(title).toMatchObject({ temperature: 0.3, maxOutputTokens: 50 });
    expect(fill).toMatchObject({ temperature: 0, maxOutputTokens: 80, responseFormat: { type: 'json_schema', json_schema: { name: 'create_reminder' } } });
    expect(fill.messages[0].content).toContain('what to be reminded of, short, without the time');
    expect(fill.expectedJson.remindAtLocal).toBe('2026-10-07T16:00');
    expect(definitions.map((entry: TrialRequest) => entry.workload)).not.toContain('portal');
    expect(JSON.parse(readFileSync(join(output, 'sources.json'), 'utf8')).sourceFingerprints).toHaveProperty('src/Murmur8.Application/AI/AssistantStep/AssistantStepFill.cs');
    expect(() => adapter.prepareP1Fixtures(sourceRoot, output)).toThrow();
  });

  it('fails fixture preparation before writing when source evidence is missing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'slot-trial-fixtures-'));
    directories.push(directory);
    expect(() => adapter.prepareP1Fixtures(directory, join(directory, 'output'))).toThrow();
    expect(existsSync(join(directory, 'output'))).toBe(false);
  });
});
