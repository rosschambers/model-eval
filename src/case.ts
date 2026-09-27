// Test-case schema for the benchmark harness. A BenchCase describes one SMS the
// model must handle, the conversation history leading up to it, optional per-case
// tool mocks, and the deterministic assertions used to grade the resulting tool
// usage. The scorer (./score.ts) consumes Transcript + Assertion[] and returns
// one AssertionResult per assertion.

import type { MockMap } from './mock-engine.js';

/** One tool call the agent made in an earlier turn, with its arguments as the model emitted them. */
export interface HistoryToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * One message of an earlier turn, in a surface-neutral authoring form. Each profile's
 * `replayHistory` renders these into the exact messages its production memory replays
 * (./history.ts). A tool message's `content` is the raw JSON the tool returned.
 */
export type HistoryMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: undefined }
  | { role: 'assistant'; content: string | null; toolCalls: HistoryToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

/** A chat-completions tool call as it goes over the wire. */
export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A chat-completions message as it goes over the wire. */
export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  // Set true when this call's tool result parsed to an object with an `error` key.
  resultIsError?: boolean;
  // The `nextCursor` value parsed from this call's tool result, if the result was
  // a JSON object carrying one (string while pages remain, null when exhausted).
  resultNextCursor?: string | null;
  // Argument names the tool's schema does not define. Production ignores them
  // silently (so a filter the model thinks it applied never applies); recorded so
  // results show the drift even when the case passes.
  unknownArguments?: string[];
}

export interface Transcript {
  toolCalls: ToolCallRecord[];
  finalText: string;
  iterations: number;
  latencyMs: number;
}

export type Assertion =
  | { kind: 'toolCalled'; tool: string }
  | { kind: 'toolNotCalled'; tool: string }
  | { kind: 'argEquals'; tool: string; path: string; value: unknown }
  | { kind: 'argMatches'; tool: string; path: string; regex: string }
  | { kind: 'argIsUtc'; tool: string; path: string }
  | { kind: 'argInstant'; tool: string; path: string; value: string }
  | { kind: 'argIsLocalNoZ'; tool: string; path: string }
  | { kind: 'callOrder'; before: string; after: string }
  | { kind: 'noNameAsId'; tool: string; path: string; names: string[] }
  | { kind: 'toolCalledAnyOf'; tools: string[] }
  | { kind: 'noFabrication' }
  | { kind: 'noSuccessAfterError'; tool: string }
  | { kind: 'pagedAllResults'; tool: string };

export interface BenchCase {
  id: string;
  capability: string;
  history?: HistoryMessage[];
  // The history already rendered into the messages the profile's production memory replays.
  // Set by the runner (./run.ts) from the profile's replayHistory; never written in a case. When
  // absent, the loop renders `history` with the generic OpenAI replay.
  replayedHistory?: WireMessage[];
  sms: string;
  mocks?: MockMap;
  expect: Assertion[];
  replyRubric?: string;
  // A verbatim <screen-context> block describing the page the user is currently
  // looking at (route, active-item, active-container, visible-items). When set,
  // the runner injects it as a TRAILING system message after the user sms,
  // mirroring how the production portal agent supplies screen context.
  screenContext?: string;
  // The per-request <user-context> block (timezone + current time). When set, the
  // runner injects it as the FINAL trailing system message, after screenContext,
  // mirroring the murmur8 portal agent's ChatMessageBuilder ordering.
  userContext?: string;
}

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  detail: string;
}
