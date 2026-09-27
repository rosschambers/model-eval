import { describe, it, expect } from 'vitest';
import {
  HUGO_CONTEXT_WINDOW_LENGTH,
  orderKeysLikeJsonb,
  replayHugoHistory,
  replayOpenAiHistory,
  replayPortalHistory,
  toJsonbText,
} from './history.js';
import type { HistoryMessage } from './case.js';

// One earlier tool-using turn in the neutral authoring format: the user asks, the agent lists
// calendars, then creates the event, then replies.
const TOOL_TURN: HistoryMessage[] = [
  { role: 'user', content: 'add Dentist to my Personal calendar today at 3pm' },
  {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'callList', name: 'list', arguments: { type: 'calendars' } }],
  },
  { role: 'tool', toolCallId: 'callList', name: 'list', content: '{"results":[{"id":"cal-1","name":"Personal"}],"nextCursor":null}' },
  {
    role: 'assistant',
    content: null,
    toolCalls: [
      {
        id: 'callCreate',
        name: 'create',
        arguments: { type: 'calendar_event', calendarId: 'cal-1', title: 'Dentist', startTime: '2026-06-26T15:00:00' },
      },
    ],
  },
  { role: 'tool', toolCallId: 'callCreate', name: 'create', content: '{"Id":"mock-evt-dentist","Title":"Dentist"}' },
  { role: 'assistant', content: 'Done — Dentist is on your Personal calendar today at 3pm.' },
];

describe('orderKeysLikeJsonb', () => {
  it('orders keys shortest first, then bytewise — the order Postgres jsonb stores them in', () => {
    // hugo_chat_history row 1057 stores the arguments of a call the model emitted as
    // {type,start,end,tool,id} in the order {id,end,tool,type,start}.
    const ordered = orderKeysLikeJsonb({
      type: 'calendar_events',
      start: '2026-09-28T00:00:00Z',
      end: '2026-09-28T23:59:59Z',
      tool: 'list',
      id: 'nbjYcJPEmIYWoC4iN799uymW7euGN641',
    });
    expect(JSON.stringify(ordered)).toBe(
      '{"id":"nbjYcJPEmIYWoC4iN799uymW7euGN641","end":"2026-09-28T23:59:59Z","tool":"list","type":"calendar_events","start":"2026-09-28T00:00:00Z"}',
    );
  });

  it('reorders nested objects and objects inside arrays too', () => {
    expect(JSON.stringify(orderKeysLikeJsonb({ outer: [{ bb: 1, a: 2 }], z: { title: 1, id: 2 } }))).toBe(
      '{"z":{"id":2,"title":1},"outer":[{"a":2,"bb":1}]}',
    );
  });
});

describe('toJsonbText', () => {
  it('renders the Postgres jsonb text form: reordered keys, ": " and ", " separators', () => {
    // murmur8 ConversationMessages.ToolResult (jsonb) for a create task, read back as text.
    const raw =
      '{"Id":"8538dbc6","Title":"Bug","Tags":["Bug"],"Ref":{"entityType":"TaskItem","entityId":"8538dbc6"},"DueDate":null,"Status":0}';
    expect(toJsonbText(JSON.parse(raw))).toBe(
      '{"Id": "8538dbc6", "Ref": {"entityId": "8538dbc6", "entityType": "TaskItem"}, "Tags": ["Bug"], "Title": "Bug", "Status": 0, "DueDate": null}',
    );
  });

  it('renders empty containers without inner spaces', () => {
    expect(toJsonbText({ results: [], extra: {} })).toBe('{"extra": {}, "results": []}');
  });
});

describe('replayOpenAiHistory (the generic default)', () => {
  it('keeps text-only history exactly as {role, content}', () => {
    expect(
      replayOpenAiHistory([
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'reply' },
      ]),
    ).toEqual([
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'reply' },
    ]);
  });

  it('renders assistant tool calls and tool results as OpenAI chat messages, in order', () => {
    const replayed = replayOpenAiHistory(TOOL_TURN);
    expect(replayed.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
    expect(replayed[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'callList', type: 'function', function: { name: 'list', arguments: '{"type":"calendars"}' } }],
    });
    expect(replayed[2]).toEqual({
      role: 'tool',
      tool_call_id: 'callList',
      content: '{"results":[{"id":"cal-1","name":"Personal"}],"nextCursor":null}',
    });
  });
});

describe('replayHugoHistory (n8n Postgres chat memory → @langchain/openai)', () => {
  it('uses the contextWindowLength the live workflow sets', () => {
    expect(HUGO_CONTEXT_WINDOW_LENGTH).toBe(4);
  });

  it('replays a tool call as an assistant message with EMPTY content and a single call whose arguments carry the injected tool and id keys in jsonb order', () => {
    const replayed = replayHugoHistory(TOOL_TURN);
    expect(replayed[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'callList',
          type: 'function',
          function: { name: 'list', arguments: '{"id":"callList","tool":"list","type":"calendars"}' },
        },
      ],
    });
    expect(replayed[3].tool_calls?.[0].function.arguments).toBe(
      '{"id":"callCreate","tool":"create","type":"calendar_event","title":"Dentist","startTime":"2026-06-26T15:00:00","calendarId":"cal-1"}',
    );
  });

  it('replays a tool result with its tool name and wrapped in the MCP response envelope', () => {
    const replayed = replayHugoHistory(TOOL_TURN);
    expect(replayed[2]).toEqual({
      role: 'tool',
      name: 'list',
      tool_call_id: 'callList',
      content: '[{"response":[{"type":"text","text":"{\\"results\\":[{\\"id\\":\\"cal-1\\",\\"name\\":\\"Personal\\"}],\\"nextCursor\\":null}"}]}]',
    });
  });

  it('keeps user and final assistant turns as plain {role, content}', () => {
    const replayed = replayHugoHistory(TOOL_TURN);
    expect(replayed[0]).toEqual({ role: 'user', content: 'add Dentist to my Personal calendar today at 3pm' });
    expect(replayed[5]).toEqual({ role: 'assistant', content: 'Done — Dentist is on your Personal calendar today at 3pm.' });
  });

  it('splits parallel tool calls into one assistant + tool pair per call, as n8n saves one step per call', () => {
    const replayed = replayHugoHistory([
      { role: 'user', content: 'u' },
      {
        role: 'assistant',
        content: 'narration n8n never stores',
        toolCalls: [
          { id: 'a', name: 'list', arguments: { type: 'calendars' } },
          { id: 'b', name: 'list', arguments: { type: 'task_lists' } },
        ],
      },
      { role: 'tool', toolCallId: 'a', name: 'list', content: '{"results":[]}' },
      { role: 'tool', toolCallId: 'b', name: 'list', content: '{"results":[]}' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(replayed.map((message) => [message.role, message.tool_call_id ?? message.tool_calls?.[0].id ?? null])).toEqual([
      ['user', null],
      ['assistant', 'a'],
      ['tool', 'a'],
      ['assistant', 'b'],
      ['tool', 'b'],
      ['assistant', null],
    ]);
    expect(replayed[1].content).toBe('');
  });

  it('replays only the last contextWindowLength × 2 stored messages, tool messages counted', () => {
    const turns: HistoryMessage[] = [];
    for (let index = 0; index < 6; index++) {
      turns.push({ role: 'user', content: `user ${index}` }, { role: 'assistant', content: `reply ${index}` });
    }
    const replayed = replayHugoHistory(turns);
    expect(replayed).toHaveLength(8);
    expect(replayed[0]).toEqual({ role: 'user', content: 'user 2' });
  });

  it('drops a tool message the window opened on (n8n cleanupOrphanedMessages)', () => {
    // 6 stored for the tool turn + 4 text = 10 → the last 8 open on tool(list), whose call was cut.
    const replayed = replayHugoHistory([
      ...TOOL_TURN,
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'y' },
      { role: 'user', content: 'z' },
      { role: 'assistant', content: 'w' },
    ]);
    expect(replayed).toHaveLength(7);
    expect(replayed[0].tool_calls?.[0].id).toBe('callCreate');
    expect(replayed[1]).toMatchObject({ role: 'tool', tool_call_id: 'callCreate' });
  });

  it('keeps a tool call the window opens on when its result follows it', () => {
    // 6 + 5 = 11 stored → the last 8 open on ai(create), still followed by its tool result.
    const replayed = replayHugoHistory([
      ...TOOL_TURN,
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'y' },
      { role: 'user', content: 'z' },
      { role: 'assistant', content: 'w' },
      { role: 'user', content: 'v' },
    ]);
    expect(replayed).toHaveLength(8);
    expect(replayed[0].tool_calls?.[0].id).toBe('callCreate');
  });
});

describe('replayPortalHistory (murmur8 ConversationHistoryMapper → OpenAiCompatibleChatCompletionService)', () => {
  it('omits content on a tool-call assistant message whose text was empty, and keeps the model argument string', () => {
    const replayed = replayPortalHistory(TOOL_TURN);
    expect(replayed[1]).toEqual({
      role: 'assistant',
      tool_calls: [{ id: 'callList', type: 'function', function: { name: 'list', arguments: '{"type":"calendars"}' } }],
    });
    expect('content' in replayed[1]).toBe(false);
  });

  it('wraps tool results in <tool-result> data tags around the jsonb text, with no name field', () => {
    const replayed = replayPortalHistory(TOOL_TURN);
    expect(replayed[2]).toEqual({
      role: 'tool',
      tool_call_id: 'callList',
      content:
        '<tool-result name="list" type="data">\n{"results": [{"id": "cal-1", "name": "Personal"}], "nextCursor": null}\n</tool-result>',
    });
  });

  it('keeps an assistant tool-call message text when the model streamed some', () => {
    const replayed = replayPortalHistory([
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'Checking.', toolCalls: [{ id: 'a', name: 'list', arguments: { type: 'calendars' } }] },
      { role: 'tool', toolCallId: 'a', name: 'list', content: '{"results":[]}' },
      { role: 'assistant', content: 'none' },
    ]);
    expect(replayed[1].content).toBe('Checking.');
  });

  it('pulls each result right after its parent call and gives an orphaned call the interrupted error', () => {
    const replayed = replayPortalHistory([
      { role: 'user', content: 'u' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'a', name: 'list', arguments: { type: 'calendars' } },
          { id: 'b', name: 'list', arguments: { type: 'task_lists' } },
        ],
      },
      { role: 'tool', toolCallId: 'a', name: 'list', content: '{"results":[]}' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(replayed.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
    expect(replayed[3]).toEqual({ role: 'tool', tool_call_id: 'b', content: '{"error":"Tool execution was interrupted"}' });
  });

  it('merges consecutive user messages the way the mapper does', () => {
    expect(
      replayPortalHistory([
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: 'ok' },
      ]),
    ).toEqual([
      { role: 'user', content: 'one\n\ntwo' },
      { role: 'assistant', content: 'ok' },
    ]);
  });
});
