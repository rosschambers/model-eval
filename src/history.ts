// History replay. A case writes its earlier turns once, surface-neutral (HistoryMessage). Each
// profile renders them into the exact chat-completions messages its production memory replays to
// the model on the follow-up turn, so a memory case sees what the live agent sees.
// Current-turn renderers share result formatting, but do not apply the memory window or the
// database transformations that only happen after a Hugo turn is saved.
//
// Ground truth (verified 2026-09-27 against the live n8n container, n8n-postgres, murmur8-postgres
// and the murmur8 source):
//
// Hugo (n8n 2.14.2, workflow hBy4thWfDRILEv5O, memoryPostgresChat v1.3, table hugo_chat_history):
// - Save: per turn, HumanMessage(full agent input, REQUEST CONTEXT included), then for EVERY tool
//   step one AIMessage("Calling <tool> with input: {...}", tool_calls:[that one call]) plus one
//   ToolMessage(name, tool_call_id, observation), then AIMessage(final reply)
//   (utils/agent-execution/memoryManagement.js saveToMemory + buildSteps.js).
// - Every call's arguments gain `id` (the call id); toolkit tools (the Murmur8 MCP node) also gain
//   `tool` (createEngineRequests.js `isFromToolkit`). The row is jsonb, so arguments come back with
//   jsonb key order (hugo_chat_history rows 1057, 971, 999).
// - Observation = JSON.stringify of the tool node's ai_tool items: MCP tools give
//   [{"response":[{"type":"text","text":"<result JSON>"}]}] (rows 959, 972, 1000); code tools give
//   [{"response":"<string>"}] (ToolCode.node.js:78, not seen in stored rows).
// - Load: BufferWindowMemory returns messages.slice(-k * 2) — k = contextWindowLength = 4, so the
//   last 8 stored MESSAGES, tool messages counted — then cleanupOrphanedMessages drops a leading
//   ToolMessage or a leading tool-call AIMessage not followed by its ToolMessage
//   (buffer_window_memory.cjs, memoryManagement.js loadMemory; no maxTokensFromMemory set).
// - Wire: @langchain/openai 1.1.3 convertMessagesToCompletionsMessageParams sends an AIMessage with
//   tool_calls as content "" (the stored "Calling ..." text is dropped) and arguments
//   JSON.stringify(args); a ToolMessage keeps `name` and `tool_call_id`.
//   Execution 378620 (session probe-weekday-20260926, second turn) loaded exactly this history.
//
// murmur8 portal (ConversationHistoryMapper.cs, ChatMessageBuilder.cs, AgentOrchestrator.cs,
// OpenAiCompatibleChatCompletionService.cs):
// - The whole conversation is replayed (no window) until compaction, which only runs after a turn
//   whose prompt exceeded CompactionTriggerTokens (16000) and keeps the last 5 user turns verbatim.
// - One assistant message per model step, carrying ALL its tool calls with the model's own
//   argument string; content is omitted when the model streamed no text (WhenWritingNull).
// - Each result is pulled right after its parent call as
//   <tool-result name="X" type="data">\n{jsonb text}\n</tool-result> with tool_call_id and no
//   name; ToolResult is a jsonb column, so the text is Postgres jsonb output (": " and ", "
//   separators, keys reordered). A call with no result gets {"error":"Tool execution was
//   interrupted"} unwrapped. Consecutive user messages merge with a blank line.

import type { BenchCase, HistoryMessage, HistoryToolCall, WireMessage, WireToolCall } from './case.js';

/** memoryPostgresChat contextWindowLength on the live Hugo workflow. */
export const HUGO_CONTEXT_WINDOW_LENGTH = 4;

/** Hugo's n8n code tools: standalone tools, not from the MCP toolkit, returning a plain string. */
const HUGO_CODE_TOOLS = new Set(['Parse_Date_Time', 'Convert_Time']);

const TOOL_INTERRUPTED_ERROR = JSON.stringify({ error: 'Tool execution was interrupted' });

/** Postgres jsonb key order: shorter keys first (in UTF-8 bytes), then bytewise. */
function compareJsonbKeys(left: string, right: string): number {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) return leftBytes.length - rightBytes.length;
  return Buffer.compare(leftBytes, rightBytes);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Rebuild a JSON value with every object's keys in the order Postgres jsonb stores them. */
export function orderKeysLikeJsonb(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => orderKeysLikeJsonb(item));
  if (!isPlainObject(value)) return value;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareJsonbKeys)) {
    ordered[key] = orderKeysLikeJsonb(value[key]);
  }
  return ordered;
}

/** Render a JSON value the way Postgres prints a jsonb value as text. */
export function toJsonbText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => toJsonbText(item)).join(', ')}]`;
  if (isPlainObject(value)) {
    const members = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort(compareJsonbKeys)
      .map((key) => `${JSON.stringify(key)}: ${toJsonbText(value[key])}`);
    return `{${members.join(', ')}}`;
  }
  return JSON.stringify(value);
}

function wireToolCall(call: HistoryToolCall, argumentsText: string): WireToolCall {
  return { id: call.id, type: 'function', function: { name: call.name, arguments: argumentsText } };
}

function findToolResult(history: HistoryMessage[], callId: string): Extract<HistoryMessage, { role: 'tool' }> | undefined {
  for (const message of history) {
    if (message.role === 'tool' && message.toolCallId === callId) return message;
  }
  return undefined;
}

/**
 * The generic replay: plain OpenAI chat messages, one per history message. Text-only history
 * renders as `{role, content}` exactly as the loop always sent it.
 */
export function replayOpenAiHistory(history: HistoryMessage[]): WireMessage[] {
  return history.map((message): WireMessage => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    }
    if (message.role === 'assistant' && message.toolCalls !== undefined) {
      return {
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls.map((call) => wireToolCall(call, JSON.stringify(call.arguments))),
      };
    }
    return { role: message.role, content: message.content };
  });
}

/** The observation n8n records for a tool: its ai_tool output items, JSON-encoded. */
function hugoObservation(toolName: string, rawResult: string): string {
  if (HUGO_CODE_TOOLS.has(toolName)) return JSON.stringify([{ response: rawResult }]);
  return JSON.stringify([{ response: [{ type: 'text', text: rawResult }] }]);
}

/** n8n adds transport fields before execution resumes; only persisted history gets jsonb ordering. */
function hugoArguments(call: HistoryToolCall, fromMemory: boolean = true): string {
  const injected: Record<string, unknown> = { ...call.arguments };
  if (!HUGO_CODE_TOOLS.has(call.name)) injected.tool = call.name;
  injected.id = call.id;
  return JSON.stringify(fromMemory ? orderKeysLikeJsonb(injected) : injected);
}

/**
 * Current Hugo steps: n8n 2.14.2 buildSteps.ts reconstructs one call per result without a database
 * round trip. @langchain/classic 1.0.17 format_scratchpad/tool_calling.js puts the tool name in
 * additional_kwargs, NOT ToolMessage.name; @langchain/openai 1.1.3 converters/completions.js omits
 * it on the wire. Unlike memory replay: insertion-order arguments and no tool-message name.
 */
export function renderHugoToolExchange(message: WireMessage, results: string[]): WireMessage[] {
  const messages: WireMessage[] = [];
  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    let argumentsText = call.function.arguments;
    try {
      argumentsText = hugoArguments({
        id: call.id, name: call.function.name, arguments: JSON.parse(argumentsText),
      }, false);
    } catch {
      // Preserve the harness's malformed-argument record rather than inventing valid arguments.
    }
    messages.push({
      role: 'assistant', content: '',
      tool_calls: [{ id: call.id, type: 'function', function: { name: call.function.name, arguments: argumentsText } }],
    });
    messages.push({ role: 'tool', tool_call_id: call.id, content: hugoObservation(call.function.name, results[index]) });
  }
  return messages;
}

/**
 * Portal ToolExecutor persists each result before AgentOrchestrator reloads the conversation on
 * the next iteration. The current turn therefore uses the same jsonb text and data tags as history.
 * Keep the model's argument strings and grouped calls; transport fields never enter the scorer.
 */
export function renderPortalToolExchange(message: WireMessage, results: string[]): WireMessage[] {
  const assistant: WireMessage = { role: 'assistant', tool_calls: message.tool_calls };
  if (message.content) assistant.content = message.content;
  return [assistant, ...(message.tool_calls ?? []).map((call, index): WireMessage => ({
    role: 'tool', tool_call_id: call.id,
    content: `<tool-result name="${call.function.name}" type="data">\n${portalResultText(results[index])}\n</tool-result>`,
  }))];
}

/** n8n loadMemory's cleanupOrphanedMessages, applied to the replayed window. */
function dropOrphanedLeadingMessages(messages: WireMessage[]): WireMessage[] {
  const window = [...messages];
  let changed = true;
  while (changed && window.length > 0) {
    changed = false;
    while (window.length > 0 && window[0].role === 'tool') {
      window.shift();
      changed = true;
    }
    const first = window[0];
    const orphanedCall =
      first !== undefined && first.role === 'assistant' && (first.tool_calls?.length ?? 0) > 0 && window[1]?.role !== 'tool';
    if (orphanedCall) {
      window.shift();
      changed = true;
    }
  }
  return window;
}

/**
 * Hugo's replay: the n8n Postgres chat memory stores one assistant + tool pair per tool call and
 * replays the last `windowLength` × 2 stored messages through @langchain/openai.
 */
export function replayHugoHistory(history: HistoryMessage[], windowLength: number = HUGO_CONTEXT_WINDOW_LENGTH): WireMessage[] {
  const stored: WireMessage[] = [];
  for (const message of history) {
    if (message.role === 'tool') continue;
    if (message.role === 'assistant' && message.toolCalls !== undefined) {
      for (const call of message.toolCalls) {
        const result = findToolResult(history, call.id);
        if (result === undefined) {
          throw new Error(`history tool call ${call.id} (${call.name}) has no tool result; n8n always stores one per step`);
        }
        stored.push({ role: 'assistant', content: '', tool_calls: [wireToolCall(call, hugoArguments(call))] });
        stored.push({ role: 'tool', name: call.name, tool_call_id: call.id, content: hugoObservation(call.name, result.content) });
      }
      continue;
    }
    stored.push({ role: message.role, content: message.content });
  }
  return dropOrphanedLeadingMessages(stored.slice(-windowLength * 2));
}

/** A tool result read back from the jsonb ToolResult column. */
function portalResultText(rawResult: string): string {
  try {
    return toJsonbText(JSON.parse(rawResult));
  } catch {
    return rawResult;
  }
}

/** The murmur8 portal's replay: ConversationHistoryMapper.AppendHistory then MapMessage. */
export function replayPortalHistory(history: HistoryMessage[]): WireMessage[] {
  const messages: WireMessage[] = [];
  const emittedResultIds = new Set<string>();
  for (const message of history) {
    if (message.role === 'tool') continue;
    if (message.role === 'user') {
      const last = messages[messages.length - 1];
      if (last !== undefined && last.role === 'user') {
        last.content = `${last.content ?? ''}\n\n${message.content}`;
      } else {
        messages.push({ role: 'user', content: message.content });
      }
      continue;
    }
    if (message.toolCalls === undefined) {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }
    const assistant: WireMessage = { role: 'assistant' };
    if (message.content !== null && message.content !== '') assistant.content = message.content;
    assistant.tool_calls = message.toolCalls.map((call) => wireToolCall(call, JSON.stringify(call.arguments)));
    messages.push(assistant);
    for (const call of message.toolCalls) {
      if (emittedResultIds.has(call.id)) continue;
      emittedResultIds.add(call.id);
      const result = findToolResult(history, call.id);
      if (result === undefined) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: TOOL_INTERRUPTED_ERROR });
        continue;
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: `<tool-result name="${call.name}" type="data">\n${portalResultText(result.content)}\n</tool-result>`,
      });
    }
  }
  return messages;
}

/** The history messages to send for a case: the profile's replay when the runner set one. */
export function historyMessages(benchCase: BenchCase): WireMessage[] {
  return benchCase.replayedHistory ?? replayOpenAiHistory(benchCase.history ?? []);
}
