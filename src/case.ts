// Test-case schema for the benchmark harness. A BenchCase describes one SMS the
// model must handle, the conversation history leading up to it, optional per-case
// tool mocks, and the deterministic assertions used to grade the resulting tool
// usage. The scorer (./score.ts) consumes Transcript + Assertion[] and returns
// one AssertionResult per assertion.

import type { MockMap } from './mock-engine.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  // Set true when this call's tool result parsed to an object with an `error` key.
  resultIsError?: boolean;
  // The `nextCursor` value parsed from this call's tool result, if the result was
  // a JSON object carrying one (string while pages remain, null when exhausted).
  resultNextCursor?: string | null;
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
  history?: ChatMessage[];
  sms: string;
  mocks?: MockMap;
  expect: Assertion[];
  replyRubric?: string;
  // A verbatim <screen-context> block describing the page the user is currently
  // looking at (route, active-item, active-container, visible-items). When set,
  // the runner injects it as a TRAILING system message after the user sms,
  // mirroring how the production portal agent supplies screen context.
  screenContext?: string;
}

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  detail: string;
}
