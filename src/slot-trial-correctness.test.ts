import { describe, expect, it, vi } from 'vitest';
import { errorOnce } from './mock-engine.js';
import { runSlotTrial, type TrialRequest, type TrialStreamChunk } from './slot-trial.js';

const request: TrialRequest = {
  requestIdentifier: 'one', workload: 'title', cacheState: 'cold',
  messages: [{ role: 'user', content: 'Name the garden planning conversation' }],
  foreignMarkers: [], maxOutputTokens: 32,
};
const tool = { type: 'function', function: { name: 'list', parameters: { type: 'object' } } };

async function run(chunks: TrialStreamChunk[], changes: Partial<TrialRequest> = {}, status: number | null = 200) {
  return runSlotTrial({
    profileLabel: 'P1', maxConcurrency: 1, maxRequests: 1, durationBudgetMs: 1000,
    requests: [{ ...request, ...changes }],
    transport: {
      preflight: async () => ({ slots: 1, contextPerSlot: 24576, modelPath: null, attentionCacheType: null, kvUnified: null }),
      stream: async () => ({ status, chunks: { async *[Symbol.asyncIterator]() { yield* chunks; } } }),
    },
  });
}

function call(name: string, argumentsJson: string, index = 0): TrialStreamChunk {
  return { choices: [{ delta: { tool_calls: [{ index, id: `call-${index}`, function: { name, arguments: argumentsJson } }] }, finish_reason: 'tool_calls' }] };
}

describe('trial correctness regressions', () => {
  it.each([null, 'length', 'content_filter'])('rejects finish reason %s', async (finishReason) => {
    const report = await run([{ choices: [{ delta: { content: 'Garden Planning' }, finish_reason: finishReason }] }]);
    expect(report.samples[0].outcome).toBe('failed');
    expect(report.latencySummaries).toEqual({});
  });

  it.each([null, 199, 300, 503])('rejects HTTP status %s', async (status) => {
    expect((await run([{ choices: [{ delta: { content: 'Garden Planning' }, finish_reason: 'stop' }] }], {}, status)).samples[0].outcome).toBe('failed');
  });

  it('does not mistake reasoning for the answer', async () => {
    expect((await run([{ choices: [{ delta: { reasoning_content: 'Garden Planning' }, finish_reason: 'stop' }] }])).samples[0].outcome).toBe('failed');
  });

  it('preserves full content and reasoning in separate channels', async () => {
    const report = await run([
      { choices: [{ delta: { reasoning_content: 'Consider ' } }] },
      { choices: [{ delta: { content: 'Garden ', reasoning_content: 'the topic' } }] },
      { choices: [{ delta: { content: 'Planning' }, finish_reason: 'stop' }] },
    ]);
    expect(report.samples[0]).toMatchObject({ outcome: 'completed', content: 'Garden Planning', reasoning: 'Consider the topic' });
  });

  it.each(['', '   ', 'Here is your requested title: Garden Planning.', 'Garden', '"Garden Planning"'])('rejects invalid title %j', async (content) => {
    expect((await run([{ choices: [{ delta: { content }, finish_reason: 'stop' }] }])).samples[0].outcome).toBe('failed');
  });

  it('validates fill JSON against the exact synthetic expected value', async () => {
    const changes = { workload: 'fill' as const, expectedJson: { name: 'Garden' } };
    for (const content of ['not JSON', 'null', '{"name":"Wrong"}', '{"name":"Garden","extra":true}']) {
      expect((await run([{ choices: [{ delta: { content }, finish_reason: 'stop' }] }], changes)).samples[0].outcome).toBe('failed');
    }
    expect((await run([{ choices: [{ delta: { content: '{"name":"Garden"}' }, finish_reason: 'stop' }] }], changes)).samples[0].outcome).toBe('completed');
  });

  it('rejects unknown tools, non-object arguments and mock errors', async () => {
    for (const [name, argumentsJson] of [['unknown', '{}'], ['list', 'null'], ['list', '[]'], ['list', '"text"']]) {
      expect((await run([call(name, argumentsJson)], { workload: 'portal', tools: [tool], expectedToolCalls: [{ name: 'list', arguments: {} }] })).samples[0].outcome).toBe('failed');
    }
    expect((await run([call('list', '{}')], {
      workload: 'portal', tools: [tool], expectedToolCalls: [{ name: 'list', arguments: {} }],
      createMocks: () => ({ list: () => ({ error: 'synthetic failure' }) }),
    })).samples[0].outcome).toBe('failed');
  });

  it('requires exact call count and argument values independent of property order', async () => {
    const changes = { workload: 'portal' as const, tools: [tool], expectedToolCalls: [{ name: 'list', arguments: { type: 'tasks', pageSize: 1 } }] };
    const correct = call('list', '{"pageSize":1,"type":"tasks"}');
    expect((await run([correct], changes)).samples[0].outcome).toBe('completed');
    expect((await run([correct, call('list', '{"pageSize":1,"type":"tasks"}', 1)], changes)).samples[0].outcome).toBe('failed');
    expect((await run([correct], { workload: 'portal', tools: [tool] })).samples[0].outcome).toBe('failed');
  });

  it('finds the portal marker in actual arguments but still rejects the extra NeedsAction filter', async () => {
    // Sanitized P1-mixed-prefix-20261007 response: empty content, one list call,
    // own taskListId present, but the model narrows active tasks to NeedsAction.
    const argumentsJson = '{"type":"tasks","taskListId":"synthetic-active-board","status":"NeedsAction","pageSize":1}';
    const report = await run([call('list', argumentsJson)], {
      workload: 'portal', ownMarker: 'synthetic-active-board', tools: [tool],
      expectedToolCalls: [{ name: 'list', arguments: { type: 'tasks', taskListId: 'synthetic-active-board', pageSize: 1 } }],
      createMocks: () => ({ list: () => ({ results: [], nextCursor: null }) }),
    });
    expect(report.samples[0]).toMatchObject({
      outcome: 'failed', content: '', foreignMarkers: [],
      validationErrors: ['tool calls did not match the exact expected sequence and arguments'],
    });
    expect(report.samples[0].reconstructedToolCalls?.[0].argumentsJson).toBe(argumentsJson);
    expect(report.samples[0].reconstructedToolCalls?.[0].arguments?.status).toBe('NeedsAction');
    expect(report.successful).toBe(false);
  });

  it('accepts an own marker split across tool deltas with interleaved reasoning', async () => {
    const report = await run([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'synthetic-call', function: { name: 'list', arguments: '{"type":"tasks","taskListId":"synthetic-' } }] } }] },
      { choices: [{ delta: { reasoning_content: 'Select the requested board.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'active-board","pageSize":1}' } }] }, finish_reason: 'tool_calls' }] },
    ], {
      workload: 'portal', ownMarker: 'synthetic-active-board', tools: [tool],
      expectedToolCalls: [{ name: 'list', arguments: { type: 'tasks', taskListId: 'synthetic-active-board', pageSize: 1 } }],
    });
    expect(report.samples[0].outcome).toBe('completed');
    expect(report.samples[0].validationErrors).toEqual([]);
    expect(report.samples[0].content).toBe('');
  });

  it('finds a marker in decoded tool data when JSON escapes hide it in the wire string', async () => {
    const report = await run([call('list', '{"type":"tasks","taskListId":"synthetic\\u002dactive\\u002dboard","pageSize":1}')], {
      workload: 'portal', ownMarker: 'synthetic-active-board', tools: [tool],
      expectedToolCalls: [{ name: 'list', arguments: { type: 'tasks', taskListId: 'synthetic-active-board', pageSize: 1 } }],
    });
    expect(report.samples[0].outcome).toBe('completed');
    expect(report.samples[0].validationErrors).toEqual([]);
  });

  it('checks reasoning as an output channel without treating it as the final answer', async () => {
    const report = await run([{ choices: [{ delta: { content: 'Garden Planning', reasoning_content: 'synthetic-active-board' }, finish_reason: 'stop' }] }], { ownMarker: 'synthetic-active-board' });
    expect(report.samples[0].outcome).toBe('completed');
    const reasoningOnly = await run([{ choices: [{ delta: { reasoning_content: 'synthetic-active-board' }, finish_reason: 'stop' }] }], { ownMarker: 'synthetic-active-board' });
    expect(reasoningOnly.samples[0].outcome).toBe('failed');
    expect(reasoningOnly.samples[0].validationErrors.join(' ')).not.toContain('own marker');
  });

  it('does not satisfy an own marker from a request or mock result', async () => {
    const report = await run([call('list', '{"type":"tasks"}')], {
      workload: 'portal', ownMarker: 'synthetic-active-board', tools: [tool],
      messages: [{ role: 'user', content: 'Read synthetic-active-board' }],
      expectedToolCalls: [{ name: 'list', arguments: { type: 'tasks' } }],
      createMocks: () => ({ list: () => ({ results: [{ title: 'synthetic-active-board' }] }) }),
    });
    expect(report.samples[0].outcome).toBe('failed');
    expect(report.samples[0].validationErrors.join(' ')).toContain('own marker');
  });

  it('also finds foreign markers in decoded tool data', async () => {
    const report = await run([call('list', '{"type":"tasks","taskListId":"foreign\\u002dboard"}')], {
      workload: 'portal', foreignMarkers: ['foreign-board'], tools: [tool],
      expectedToolCalls: [{ name: 'list', arguments: { type: 'tasks', taskListId: 'foreign-board' } }],
    });
    expect(report.samples[0].foreignMarkers).toEqual(['foreign-board']);
    expect(report.samples[0].outcome).toBe('failed');
  });

  it('reconstructs fragmented function names as well as arguments', async () => {
    const report = await run([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-one', function: { name: 'li', arguments: '{"type":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'st', arguments: '"tasks"}' } }] }, finish_reason: 'tool_calls' }] },
    ], { workload: 'portal', tools: [tool], expectedToolCalls: [{ name: 'list', arguments: { type: 'tasks' } }] });
    expect(report.samples[0].outcome).toBe('completed');
    expect(report.samples[0].reconstructedToolCalls?.[0].name).toBe('list');
  });

  it.each([-1, NaN, 33])('rejects invalid or over-budget output usage %s', async (completionTokens) => {
    const report = await run([{ choices: [{ delta: { content: 'Garden Planning' }, finish_reason: 'stop' }], usage: { completion_tokens: completionTokens } }]);
    expect(report.samples[0].outcome).toBe('failed');
  });

  it('marks contamination as failed and excludes it from valid latency', async () => {
    const report = await run([{ choices: [{ delta: { content: 'FOREIGN Marker' }, finish_reason: 'stop' }] }], { foreignMarkers: ['FOREIGN'] });
    expect(report.samples[0].outcome).toBe('failed');
    expect(report.latencySummaries).toEqual({});
  });

  it('allows explicitly unverified cache labels instead of inventing a cold seed', async () => {
    const report = await run([{ choices: [{ delta: { content: 'Garden Planning' }, finish_reason: 'stop' }] }], { cacheState: 'unverified' });
    expect(report.samples[0].cacheState).toBe('unverified');
    expect(report.samples[0].outcome).toBe('completed');
  });

  it('rejects shared function mocks and calls a factory separately for every request', async () => {
    await expect(run([call('list', '{}')], { mocks: { list: errorOnce({ code: 500, message: 'first' }, {}) } })).rejects.toThrow(/factory|createMocks/i);
    const createMocks = vi.fn(() => ({ list: errorOnce({ code: 500, message: 'first' }, {}) }));
    const report = await runSlotTrial({
      profileLabel: 'P1', maxConcurrency: 2, maxRequests: 2, durationBudgetMs: 1000,
      requests: ['one', 'two'].map((requestIdentifier) => ({ ...request, requestIdentifier, workload: 'portal', tools: [tool], expectedToolCalls: [{ name: 'list', arguments: {} }], createMocks })),
      transport: {
        preflight: async () => ({ slots: 1, contextPerSlot: 24576, modelPath: null, attentionCacheType: null, kvUnified: null }),
        stream: async () => ({ status: 200, chunks: { async *[Symbol.asyncIterator]() { yield call('list', '{}'); } } }),
      },
    });
    expect(createMocks).toHaveBeenCalledTimes(2);
    expect(report.samples.map((sample) => sample.reconstructedToolCalls?.[0].mockResult)).toEqual([
      { error: { code: 500, message: 'first' } }, { error: { code: 500, message: 'first' } },
    ]);
  });
});
