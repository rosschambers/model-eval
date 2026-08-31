// Deterministic mock engine. Answers a model's tool calls with canned data so
// the harness can grade tool usage without any real side effects. The two
// date/time tools delegate to the faithful code-tools ports; everything else is
// served from per-case mocks (when supplied) or the shared defaultMocks.

import { parseDateTime, convertTime } from './code-tools.js';
import responses from '../fixtures/responses-fixture.json' with { type: 'json' };

const DEFAULT_TZ = 'America/Detroit';

export type MockMap = Record<string, (args: any) => unknown>;

/**
 * Canned returns for the common Murmur8 tools, dispatching on `args.type`.
 * The list rows are sourced from fixtures/responses-fixture.json so their field
 * shapes mirror real Murmur8 MCP responses. Used when a case does not override a
 * given tool.
 */
export const defaultMocks: MockMap = {
  list: (args: any) => {
    switch (args.type) {
      case 'calendars':
        return { results: responses.calendars, nextCursor: null };
      case 'task_lists':
        return { results: responses.taskLists, nextCursor: null };
      default:
        return { results: [], nextCursor: null };
    }
  },
  create: (args: any) => ({
    id: 'mock-' + (args.type ?? 'entity') + '-0001',
    ...args,
  }),
  update: (args: any) => ({
    id: args.taskId ?? args.eventId ?? args.calendarId ?? 'mock-updated',
    ...args,
  }),
  delete: () => ({ deleted: true }),
  search: () => ({ results: [] }),
  get: (args: any) => ({ id: args.id, found: true }),
};

/**
 * Build a mock that pages `items` `pageSize` at a time. The returned function
 * reads an incoming `args.cursor` (a stringified offset) and emits a JSON string
 * `{ results, nextCursor }`. `nextCursor` is a truthy stringified offset while
 * items remain, then `null` once the list is exhausted. Returns a JSON string so
 * callers (and runTool) can pass the payload straight through to the model.
 */
export function paginated(
  items: unknown[],
  pageSize: number,
): (args: any) => string {
  return (args: any): string => {
    const offset =
      args && args.cursor !== undefined && args.cursor !== null
        ? Number(args.cursor)
        : 0;
    const results = items.slice(offset, offset + pageSize);
    const nextOffset = offset + pageSize;
    const nextCursor = nextOffset < items.length ? String(nextOffset) : null;
    return JSON.stringify({ results, nextCursor });
  };
}

/**
 * Build a mock that fails its first invocation and succeeds thereafter. The
 * first call returns `{ __error: error }` (which runTool serializes into a
 * realistic `{ error }` payload); subsequent calls return `then`. Models must
 * retry or honestly report rather than claim success off the errored call.
 */
export function errorOnce(
  error: { code: number; message: string },
  then: unknown,
): (args: any) => unknown {
  let called = false;
  return (): unknown => {
    if (!called) {
      called = true;
      return { __error: error };
    }
    return then;
  };
}

/**
 * Resolve a tool call to its stringified result. Date/time tools are computed
 * for real; other tools are served from `mocks` (per-case) then `defaultMocks`.
 * A mock returning an object with an `__error` property is serialized as a
 * realistic `{ error }` payload. Unknown tools return a structured no-mock error.
 */
export function runTool(name: string, args: any, mocks: MockMap): string {
  // Hugo's n8n helper and murmur8's in-app tool are the same operation under two
  // names (Parse_Date_Time vs parse_date_time); both resolve via the real code-tool.
  if (name === 'Parse_Date_Time' || name === 'parse_date_time') {
    const result = parseDateTime(args, DEFAULT_TZ);
    return typeof result === 'string' ? result : JSON.stringify(result);
  }

  if (name === 'Convert_Time') {
    return convertTime(args, args.timeZone ?? DEFAULT_TZ);
  }

  const mock = mocks[name] ?? defaultMocks[name];
  if (mock) {
    const result = mock(args);
    if (
      result !== null &&
      typeof result === 'object' &&
      '__error' in (result as Record<string, unknown>)
    ) {
      return JSON.stringify({ error: (result as Record<string, unknown>).__error });
    }
    return typeof result === 'string' ? result : JSON.stringify(result);
  }

  return JSON.stringify({ error: 'no mock for tool ' + name });
}
