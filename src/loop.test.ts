import { describe, it, expect } from 'vitest';
import { runCase, MAX_ITERATIONS, type ChatClient } from './loop.js';
import { paginated, errorOnce } from './mock-engine.js';
import type { BenchCase } from './case.js';

/** A scripted assistant message that issues a single tool call by name/args. */
function toolCallMessage(name: string, args: Record<string, unknown>): any {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  };
}

/**
 * Build a stub ChatClient that returns scripted responses one per call. If the
 * script runs out, the last response is repeated. Captures the params of every
 * call for inspection.
 */
function stubClient(responses: any[]): {
  client: ChatClient;
  calls: any[];
} {
  const calls: any[] = [];
  let index = 0;
  const client: ChatClient = {
    chat: {
      completions: {
        create: async (params: any) => {
          calls.push(params);
          const response =
            responses[Math.min(index, responses.length - 1)];
          index += 1;
          return response;
        },
      },
    },
  };
  return { client, calls };
}

function baseCase(overrides: Partial<BenchCase> = {}): BenchCase {
  return {
    id: 'test-case',
    capability: 'test',
    sms: 'do the thing',
    expect: [],
    ...overrides,
  };
}

const SYS = 'You are a helpful assistant.';
const TOOLS: any[] = [];

describe('runCase', () => {
  it('executes a single tool call then returns final text', async () => {
    const { client } = stubClient([
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: {
                    name: 'list',
                    arguments: JSON.stringify({ type: 'calendars' }),
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            message: { role: 'assistant', content: 'Done. Added it.' },
          },
        ],
      },
    ]);

    const transcript = await runCase(client, 'model-x', baseCase(), SYS, TOOLS);

    expect(transcript.toolCalls.length).toBe(1);
    expect(transcript.toolCalls[0].name).toBe('list');
    expect(transcript.toolCalls[0].args.type).toBe('calendars');
    expect(transcript.finalText).toBe('Done. Added it.');
    expect(transcript.iterations).toBe(2);
  });

  it('returns final text with no tool calls', async () => {
    const { client } = stubClient([
      {
        choices: [{ message: { role: 'assistant', content: 'Hi there.' } }],
      },
    ]);

    const transcript = await runCase(client, 'model-x', baseCase(), SYS, TOOLS);

    expect(transcript.toolCalls.length).toBe(0);
    expect(transcript.finalText).toBe('Hi there.');
    expect(transcript.iterations).toBe(1);
  });

  it('records malformed tool args under _raw without throwing', async () => {
    const { client } = stubClient([
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'list', arguments: '{not json' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      },
    ]);

    const transcript = await runCase(client, 'model-x', baseCase(), SYS, TOOLS);

    expect(transcript.toolCalls.length).toBe(1);
    expect(transcript.toolCalls[0].args._raw).toBe('{not json');
  });

  it('stops at MAX_ITERATIONS when the model never finishes', async () => {
    const { client } = stubClient([
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: {
                    name: 'list',
                    arguments: JSON.stringify({ type: 'calendars' }),
                  },
                },
              ],
            },
          },
        ],
      },
    ]);

    const transcript = await runCase(client, 'model-x', baseCase(), SYS, TOOLS);

    expect(transcript.iterations).toBe(MAX_ITERATIONS);
    expect(MAX_ITERATIONS).toBe(10);
  });

  it('records resultIsError when a tool result is an error payload', async () => {
    const { client } = stubClient([
      toolCallMessage('create', { type: 'task' }),
      { choices: [{ message: { role: 'assistant', content: 'ok' } }] },
    ]);
    const c = baseCase({
      mocks: { create: errorOnce({ code: 500, message: 'boom' }, { ok: true }) },
    });

    const transcript = await runCase(client, 'model-x', c, SYS, TOOLS);

    expect(transcript.toolCalls[0].resultIsError).toBe(true);
  });

  it('records resultNextCursor when a tool result carries one', async () => {
    const { client } = stubClient([
      toolCallMessage('list', { type: 'tasks' }),
      { choices: [{ message: { role: 'assistant', content: 'ok' } }] },
    ]);
    const c = baseCase({
      mocks: { list: paginated([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 2) },
    });

    const transcript = await runCase(client, 'model-x', c, SYS, TOOLS);

    expect(transcript.toolCalls[0].resultNextCursor).toBe('2');
  });

  it('includes system, history, and user sms in the first call messages', async () => {
    const { client, calls } = stubClient([
      {
        choices: [{ message: { role: 'assistant', content: 'hello' } }],
      },
    ]);

    const c = baseCase({
      history: [{ role: 'user', content: 'earlier message' }],
      sms: 'the latest sms',
    });

    await runCase(client, 'model-x', c, SYS, TOOLS);

    const messages = calls[0].messages;
    expect(messages[0]).toEqual({ role: 'system', content: SYS });
    expect(messages).toContainEqual({ role: 'user', content: 'earlier message' });
    expect(messages[messages.length - 1]).toEqual({
      role: 'user',
      content: 'the latest sms',
    });
  });

  it('appends screenContext as a trailing system message when present', async () => {
    const { client, calls } = stubClient([
      {
        choices: [{ message: { role: 'assistant', content: 'hello' } }],
      },
    ]);

    const screen =
      '<screen-context route="tasks" type="data">\n' +
      '  <active-item type="task" id="t1">Renew passport</active-item>\n' +
      '</screen-context>';
    const c = baseCase({ sms: 'delete this', screenContext: screen });

    await runCase(client, 'model-x', c, SYS, TOOLS);

    const messages = calls[0].messages;
    // The screen-context is the final message, and it is a system message that
    // comes AFTER the user sms (a trailing system message, as production injects).
    expect(messages[messages.length - 1]).toEqual({ role: 'system', content: screen });
    const smsIndex = messages.findIndex(
      (m: any) => m.role === 'user' && m.content === 'delete this',
    );
    expect(smsIndex).toBeGreaterThan(-1);
    expect(smsIndex).toBeLessThan(messages.length - 1);
  });

  it('does not append a trailing system message when screenContext is absent', async () => {
    const { client, calls } = stubClient([
      {
        choices: [{ message: { role: 'assistant', content: 'hello' } }],
      },
    ]);

    await runCase(client, 'model-x', baseCase({ sms: 'do it' }), SYS, TOOLS);

    const messages = calls[0].messages;
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'do it' });
  });
});
