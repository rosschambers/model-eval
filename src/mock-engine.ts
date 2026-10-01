// Deterministic mock engine. Answers a model's tool calls with canned data so
// the harness can grade tool usage without any real side effects. The two
// date/time tools delegate to the faithful code-tools ports; everything else is
// served from per-case mocks (when supplied) or the shared defaultMocks. The murmur8
// read tools (`list`, `search`) answer in the production shapes of ./murmur8-results.ts.

import { parseDateTime, convertTime } from './code-tools.js';
import { NOW_UTC_ISO, USER_TIMEZONE } from './pinned-clock.js';
import {
  DEFAULT_UPDATED_AT,
  MOCK_CALENDARS,
  MOCK_TASK_LISTS,
  albumSearchItem,
  calendarEventListRow,
  calendarEventSearchItem,
  calendarSearchItem,
  decodeListCursor,
  directorySearchItem,
  emailSearchItem,
  encodeListCursor,
  fileSearchItem,
  photoSearchItem,
  reminderListRow,
  searchResult,
  taskListRow,
  taskListSearchItem,
  taskSearchItem,
  toSystemTextJson,
  type MockAlbum,
  type MockDirectory,
  type MockEmail,
  type MockEvent,
  type MockFile,
  type MockPhoto,
  type MockReminder,
  type MockTask,
  type NamedRow,
  type SearchItem,
} from './murmur8-results.js';
import { WORD_SIMILARITY_THRESHOLD, wordSimilarity } from './trigram.js';

const DEFAULT_TZ = USER_TIMEZONE;

export type MockMap = Record<string, (args: any) => unknown>;

/**
 * What a case seeds behind the murmur8 read tools; calendars and task lists are the fixture's.
 * Directories, files, albums, photos and email are served by `search` only (`list` answers those
 * types with an empty page).
 */
export interface Murmur8World {
  tasks?: readonly MockTask[];
  events?: readonly MockEvent[];
  reminders?: readonly MockReminder[];
  directories?: readonly MockDirectory[];
  files?: readonly MockFile[];
  albums?: readonly MockAlbum[];
  photos?: readonly MockPhoto[];
  emails?: readonly MockEmail[];
}

// ListTool.cs
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
// ListCalendarEventsForAiQueryHandler.MaxResults
const MAX_CALENDAR_OCCURRENCES = 50;
// SearchQueryDto.MaxResults (the SQL LIMIT, applied before the types filter)
const MAX_SEARCH_RESULTS = 25;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

// The ListTool `type` enum. A known type the world does not seed lists as an empty page.
const LIST_TYPES = new Set([
  'tasks', 'task_lists', 'task_comments', 'task_list_members', 'task_links',
  'files', 'directories', 'albums', 'photos', 'share_links',
  'calendars', 'calendar_events', 'calendar_members', 'event_attendees',
  'feed_sources', 'feed_articles', 'feed_subscriptions', 'calendar_subscriptions',
  'emails', 'email_threads', 'email_folders', 'reminders',
]);

const TASK_STATUSES = ['NeedsAction', 'InProcess', 'Completed', 'Cancelled'];
const REMINDER_STATUSES = ['Pending', 'Fired', 'Dismissed', 'Cancelled'];
const REMINDER_HISTORY_STATUSES = new Set(['all', 'fired', 'dismissed', 'cancelled']);

const TASK_SCOPE_ERROR =
  'Listing all/completed/cancelled tasks requires a taskListId (one board at a time). '
  + 'Call list with type:"task_lists" to get board IDs, then retry with taskListId set. '
  + 'To see your active tasks across all boards, omit status.';

const REMINDER_SCOPE_ERROR =
  'Listing All/Fired/Dismissed/Cancelled reminders requires a date range '
  + '(set createdAfter and/or createdBefore) to stay bounded. '
  + 'To see your upcoming reminders, omit status.';

// McpToolError.ForException: any non-validation exception (a FormatException from DateTime.Parse
// or JsonElement.GetInt32, for example) reaches the model as this generic message.
function internalError(tool: string): string {
  return toSystemTextJson({ error: `Tool '${tool}' failed with an internal error` });
}

function businessError(message: string): string {
  return toSystemTextJson({ error: message });
}

/** SchemaHelper.GetOptionalString: only a JSON string counts. */
function optionalString(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' ? value : null;
}

/**
 * ListTool.ClampPageSize over SchemaHelper.GetOptionalInt: a non-number means the default, a
 * number is clamped to 1..100, and a number that is not an Int32 throws (null here).
 */
function pageSizeOf(args: Record<string, unknown>): number | null {
  const value = args.pageSize;
  if (typeof value !== 'number') return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(value) || value > 2147483647 || value < -2147483648) return null;
  return Math.min(Math.max(value, 1), MAX_PAGE_SIZE);
}

/** .NET Enum.TryParse: a declared name (case-sensitive unless told otherwise) or a numeric value. */
function parseEnum(names: readonly string[], text: string, ignoreCase: boolean): string | null {
  const trimmed = text.trim();
  const match = names.find((name) => (ignoreCase ? name.toLowerCase() === trimmed.toLowerCase() : name === trimmed));
  if (match) return match;
  if (/^[+-]?\d+$/.test(trimmed)) return names[Number(trimmed)] ?? '#undeclared';
  return null;
}

/** A DateTime sort key, with the fraction padded so ISO strings compare in instant order. */
function instantKey(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z$/.exec(iso);
  if (!match) return iso;
  return `${match[1]}.${(match[2] ?? '').padEnd(7, '0')}`;
}

/** Ordinal id comparison (the Id tiebreaker; every fixture id is ASCII). */
function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

interface PageSource<Entity> {
  sortValue: (entity: Entity) => string;
  id: (entity: Entity) => string;
  direction: 'ascending' | 'descending';
  compareSortValues: (left: string, right: string) => number;
}

/**
 * CursorPaginator.PaginateByCursorAsync: order by the sort key then id, skip past the cursor's
 * boundary row, take one page, and encode the next cursor from the page's last row (null when the
 * set is exhausted). An unreadable cursor restarts at page 1, as ListCursor.TryDecode does.
 */
function cursorPage<Entity>(
  entities: readonly Entity[],
  source: PageSource<Entity>,
  cursor: string | null,
  pageSize: number,
): { rows: Entity[]; nextCursor: string | null } {
  const directionSign = source.direction === 'descending' ? -1 : 1;
  let ordered = [...entities].sort((left, right) => {
    const bySort = directionSign * source.compareSortValues(source.sortValue(left), source.sortValue(right));
    if (bySort !== 0) return bySort;
    return compareIds(source.id(left), source.id(right));
  });
  const decoded = decodeListCursor(cursor);
  if (decoded !== null && typeof decoded.sortValue === 'string') {
    const boundarySort = decoded.sortValue;
    ordered = ordered.filter((entity) => {
      const bySort = directionSign * source.compareSortValues(source.sortValue(entity), boundarySort);
      if (bySort > 0) return true;
      return bySort === 0 && compareIds(source.id(entity), decoded.id) > 0;
    });
  }
  const rows = ordered.slice(0, pageSize);
  let nextCursor: string | null = null;
  if (ordered.length > pageSize) {
    const boundary = rows[rows.length - 1];
    nextCursor = encodeListCursor(source.sortValue(boundary), source.id(boundary));
  }
  return { rows, nextCursor };
}

const BY_UPDATED_AT_DESCENDING = {
  direction: 'descending' as const,
  compareSortValues: (left: string, right: string): number => {
    const leftKey = instantKey(left);
    const rightKey = instantKey(right);
    if (leftKey === rightKey) return 0;
    return leftKey < rightKey ? -1 : 1;
  },
};

const BY_NAME_ASCENDING = {
  direction: 'ascending' as const,
  compareSortValues: (left: string, right: string): number => left.localeCompare(right, 'en-US'),
};

/** AiListQueryExtensions.ToAiListResult: `{ results, nextCursor }`, nextCursor always written. */
function listEnvelope(rows: Record<string, unknown>[], nextCursor: string | null): string {
  return toSystemTextJson({ results: rows, nextCursor });
}

function listNamedRows(rows: readonly NamedRow[], args: Record<string, unknown>): string {
  const pageSize = pageSizeOf(args);
  if (pageSize === null) return internalError('list');
  const page = cursorPage(rows, { ...BY_NAME_ASCENDING, sortValue: (row) => row.name, id: (row) => row.id },
    optionalString(args, 'cursor'), pageSize);
  return listEnvelope(page.rows.map((row) => ({ id: row.id, name: row.name })), page.nextCursor);
}

/** ListTool.ListTasks + ListTasksForAiQueryHandler. */
function listTasks(tasks: readonly MockTask[], args: Record<string, unknown>): string {
  const statusText = optionalString(args, 'status');
  const includeAll = statusText !== null && statusText.toLowerCase() === 'all';
  let status: string | null = null;
  if (!includeAll && statusText !== null) status = parseEnum(TASK_STATUSES, statusText, false);
  const excludeDone = !includeAll && status === null;
  const taskListId = optionalString(args, 'taskListId');
  const requiresTaskListId = includeAll || status === 'Completed' || status === 'Cancelled';
  if (requiresTaskListId && taskListId === null) return businessError(TASK_SCOPE_ERROR);
  const pageSize = pageSizeOf(args);
  if (pageSize === null) return internalError('list');

  const matching = tasks.filter((task) => {
    const taskStatus = task.status ?? 'NeedsAction';
    if (status !== null && taskStatus !== status) return false;
    if (excludeDone && (taskStatus === 'Completed' || taskStatus === 'Cancelled')) return false;
    if (taskListId !== null && task.taskListId !== taskListId) return false;
    return true;
  });
  const page = cursorPage(matching, {
    ...BY_UPDATED_AT_DESCENDING,
    sortValue: (task) => task.updatedAt ?? DEFAULT_UPDATED_AT,
    id: (task) => task.id,
  }, optionalString(args, 'cursor'), pageSize);
  return listEnvelope(page.rows.map((task) => taskListRow(task)), page.nextCursor);
}

/** ListTool.ListReminders + ListRemindersForAiQueryHandler. */
function listReminders(reminders: readonly MockReminder[], args: Record<string, unknown>): string {
  const statusText = optionalString(args, 'status');
  const hasCreatedRange = optionalString(args, 'createdAfter') !== null || optionalString(args, 'createdBefore') !== null;
  if (statusText !== null && REMINDER_HISTORY_STATUSES.has(statusText.toLowerCase()) && !hasCreatedRange) {
    return businessError(REMINDER_SCOPE_ERROR);
  }
  const pageSize = pageSizeOf(args);
  if (pageSize === null) return internalError('list');

  let status: string | null = 'Pending';
  if (statusText !== null && statusText.toLowerCase() === 'all') {
    status = null;
  } else if (statusText !== null) {
    status = parseEnum(REMINDER_STATUSES, statusText, true) ?? 'Pending';
  }
  const matching = reminders.filter((reminder) => status === null || (reminder.status ?? 'Pending') === status);
  const page = cursorPage(matching, {
    ...BY_UPDATED_AT_DESCENDING,
    sortValue: (reminder) => reminder.updatedAt ?? DEFAULT_UPDATED_AT,
    id: (reminder) => reminder.id,
  }, optionalString(args, 'cursor'), pageSize);
  return listEnvelope(page.rows.map((reminder) => reminderListRow(reminder)), page.nextCursor);
}

/**
 * ListTool.ParseRangeBoundary with the user's saved timezone: Z or an offset is that instant; no
 * designator is the user's local wall clock. Null when DateTime.Parse would throw.
 */
function parseRangeBoundary(value: string): number | null {
  const trimmed = value.trim();
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed) && /T/.test(trimmed)) {
    const instant = Date.parse(trimmed);
    return Number.isNaN(instant) ? null : instant;
  }
  const localText = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00` : trimmed;
  const parsed = parseDateTime({ localDateTime: localText }, USER_TIMEZONE);
  if (typeof parsed === 'string') return null;
  return Date.parse(parsed.utc);
}

/** ListTool.ListCalendarEvents + ListCalendarEventsForAiQueryHandler (occurrences are pre-expanded). */
function listCalendarEvents(events: readonly MockEvent[], args: Record<string, unknown>): string {
  const startText = optionalString(args, 'start');
  const endText = optionalString(args, 'end');
  let rangeStart = Date.parse(NOW_UTC_ISO);
  if (startText !== null) {
    const parsed = parseRangeBoundary(startText);
    if (parsed === null) return internalError('list');
    rangeStart = parsed;
  }
  let rangeEnd = rangeStart + 7 * DAY_MILLISECONDS;
  if (endText !== null) {
    const parsed = parseRangeBoundary(endText);
    if (parsed === null) return internalError('list');
    rangeEnd = parsed;
  }
  const calendarId = optionalString(args, 'calendarId');
  const occurrences = events
    .filter((event) => calendarId === null || event.calendarId === calendarId)
    .filter((event) => Date.parse(event.start) < rangeEnd && Date.parse(event.end) > rangeStart)
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
  const truncated = occurrences.length > MAX_CALENDAR_OCCURRENCES;
  const results = occurrences.slice(0, MAX_CALENDAR_OCCURRENCES).map((event) => calendarEventListRow(event));
  return toSystemTextJson({ results, nextCursor: null, truncated });
}

/**
 * The `list` tool over a seeded world, dispatching on `type` the way ListTool does. Calendars and
 * task lists are always the fixture's; tasks honour status, taskListId, pageSize and cursor;
 * calendar events honour the default and explicit range and calendarId; reminders honour status,
 * pageSize and cursor. Every payload is the System.Text.Json text production sends.
 */
export function listMock(world: Murmur8World = {}): (args: any) => string {
  return (args: any): string => {
    const argumentsObject: Record<string, unknown> = args !== null && typeof args === 'object' ? args : {};
    const type = argumentsObject.type;
    switch (type) {
      case 'tasks':
        return listTasks(world.tasks ?? [], argumentsObject);
      case 'task_lists':
        return listNamedRows(MOCK_TASK_LISTS, argumentsObject);
      case 'calendars':
        return listNamedRows(MOCK_CALENDARS, argumentsObject);
      case 'calendar_events':
        return listCalendarEvents(world.events ?? [], argumentsObject);
      case 'reminders':
        return listReminders(world.reminders ?? [], argumentsObject);
      default:
        if (typeof type === 'string' && LIST_TYPES.has(type)) return listEnvelope([], null);
        return toSystemTextJson({ error: `Unknown type: ${String(type)}` });
    }
  };
}

/**
 * Fixture containers (present in every world) whose name the query matches with pg_trgm
 * word_similarity at the production threshold, scored by that similarity, as SearchRepository does.
 */
function matchingContainers(
  rows: readonly NamedRow[], query: string, toItem: (row: NamedRow, score: number) => SearchItem,
): SearchItem[] {
  const items: SearchItem[] = [];
  for (const row of rows) {
    const score = wordSimilarity(query, row.name);
    if (score >= WORD_SIMILARITY_THRESHOLD) items.push(toItem(row, score));
  }
  return items;
}

/**
 * The `search` tool over a seeded world, in the SearchTool shape, covering every row kind
 * SearchRepository searches (reminders are not searchable). Case-seeded entities (tasks of every
 * status, calendar events, files, directories, albums, photos, email) are not matched against the
 * query: they are the case's matches, at Score 1. The fixture task lists and calendars sit behind
 * every case, so they are matched by name with word_similarity and scored by it. A query under two
 * characters returns nothing, items are ranked by Score (ties in the SQL's union order), the 25-row
 * limit applies before the `types` filter, and `types` is split on commas without trimming, as in
 * production.
 */
export function searchMock(world: Murmur8World = {}): (args: any) => string {
  return (args: any): string => {
    const argumentsObject: Record<string, unknown> = args !== null && typeof args === 'object' ? args : {};
    const query = argumentsObject.query;
    if (typeof query !== 'string' || query.trim() === '' || query.length < 2) {
      return toSystemTextJson(searchResult([]));
    }
    const directories = world.directories ?? [];
    const albums = world.albums ?? [];
    let items: SearchItem[] = [
      ...(world.tasks ?? []).map((task) => taskSearchItem(task)),
      ...(world.events ?? []).map((event) => calendarEventSearchItem(event)),
      ...(world.files ?? []).map((file) => fileSearchItem(file, directories)),
      ...directories.map((directory) => directorySearchItem(directory, directories)),
      ...albums.map((album) => albumSearchItem(album)),
      ...matchingContainers(MOCK_TASK_LISTS, query, taskListSearchItem),
      ...matchingContainers(MOCK_CALENDARS, query, calendarSearchItem),
      ...(world.photos ?? []).map((photo) => photoSearchItem(photo, albums)),
      ...(world.emails ?? []).map((email) => emailSearchItem(email)),
    ];
    items = items
      .map((item, index) => ({ item, index }))
      .sort((left, right) => right.item.Score - left.item.Score || left.index - right.index)
      .map((entry) => entry.item)
      .slice(0, MAX_SEARCH_RESULTS);
    const types = optionalString(argumentsObject, 'types');
    if (types !== null) {
      const wanted = types.split(',').filter((entityType) => entityType !== '');
      if (wanted.length > 0) items = items.filter((item) => wanted.includes(item.EntityType));
    }
    return toSystemTextJson(searchResult(items));
  };
}

/** `list` and `search` over one seeded world, so both lookups surface the same entities. */
export function murmur8Mocks(world: Murmur8World = {}): MockMap {
  return { list: listMock(world), search: searchMock(world) };
}

/**
 * The `list` tool over a seeded task board, for cases that test paging. Pages like production:
 * 20 rows by default, `pageSize` clamped to 1..100, active tasks unless `status` says otherwise,
 * newest first by updatedAt, production cursors, `nextCursor: null` once the board is exhausted.
 */
export function paginated(tasks: readonly MockTask[]): (args: any) => string {
  return listMock({ tasks });
}

/**
 * Canned returns for the common Murmur8 tools. `list` and `search` serve the empty world (the
 * fixture's calendars and task lists, nothing else) in production shapes; the mutation and `get`
 * mocks are still echoes, not production entities. Used when a case does not override a tool.
 */
export const defaultMocks: MockMap = {
  list: listMock(),
  create: (args: any) => ({
    id: 'mock-' + (args.type ?? 'entity') + '-0001',
    ...args,
  }),
  update: (args: any) => ({
    id: args.taskId ?? args.eventId ?? args.calendarId ?? 'mock-updated',
    ...args,
  }),
  delete: () => ({ deleted: true }),
  search: searchMock(),
  get: (args: any) => ({ id: args.id, found: true }),
};

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
