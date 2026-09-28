import { describe, it, expect } from 'vitest';
import {
  runTool,
  defaultMocks,
  paginated,
  errorOnce,
  murmur8Mocks,
  type MockMap,
} from './mock-engine.js';
import { encodeListCursor, type MockTask } from './murmur8-results.js';

const PERSONAL_ID = '2e9ee3a1-4864-467c-9147-2c2092915be1';
const HOUSEHOLD_ID = '53c6b1e2-e1fa-4cae-94ed-32a1c016e2d7';
const GROCERIES_ID = '7101b4ff-d49d-4117-a055-d3a67e9971d9';
const MURMUR8_ID = '87697694-3927-462a-b15b-21e2008c0597';

describe('runTool', () => {
  it('handles Parse_Date_Time via code-tools and JSON-stringifies', () => {
    const result = runTool(
      'Parse_Date_Time',
      { localDateTime: '2026-06-28T15:00:00' },
      {},
    );
    expect(result).toContain('"utc":"2026-06-28T19:00:00Z"');
  });

  it('handles murmur8 parse_date_time (snake_case) via the same code-tool, DST-correct', () => {
    // 2026-06-28 is EDT (UTC-4) in America/Detroit → 15:00 local = 19:00Z.
    const result = runTool(
      'parse_date_time',
      { localDateTime: '2026-06-28T15:00:00' },
      {},
    );
    expect(result).toContain('"utc":"2026-06-28T19:00:00Z"');
    expect(result).toContain('"localNaive":"2026-06-28T15:00:00"');
  });

  it('handles Convert_Time via code-tools and returns the string', () => {
    const result = runTool(
      'Convert_Time',
      { utcIso: '2026-06-28T19:00:00Z' },
      {},
    );
    expect(result).toContain('3:00');
  });

  it('lists calendars from defaultMocks when case mocks are empty', () => {
    const result = runTool('list', { type: 'calendars' }, {});
    expect(result).toContain('53c6b1e2-e1fa-4cae-94ed-32a1c016e2d7');
  });

  it('lists task lists from defaultMocks', () => {
    const result = runTool('list', { type: 'task_lists' }, {});
    expect(result).toContain('groceries');
  });

  it('echoes create args back with a fake id', () => {
    const result = runTool(
      'create',
      {
        type: 'calendar_event',
        startTime: '2026-06-28T15:00:00',
        timeZone: 'America/Detroit',
      },
      {},
    );
    expect(result).toContain('mock-calendar_event-0001');
    expect(result).toContain('2026-06-28T15:00:00');
  });

  it('lets a per-case mock override defaultMocks at the tool-function level', () => {
    const mocks: MockMap = {
      list: () => ({ results: [{ id: 'x', title: 'water bill' }] }),
    };
    const result = runTool('list', { type: 'tasks' }, mocks);
    expect(result).toContain('water bill');
  });

  it('returns a no-mock error for unknown tools', () => {
    const result = runTool('nonexistent_tool', {}, {});
    expect(result).toContain('no mock for tool nonexistent_tool');
  });
});

describe('defaultMocks', () => {
  it('is exported as a MockMap', () => {
    expect(typeof defaultMocks).toBe('object');
  });

  it('lists calendars as production does: lean {id, name} rows sorted by name, preserved ids', () => {
    const page = JSON.parse(runTool('list', { type: 'calendars' }, {}));
    expect(page).toEqual({
      results: [
        { id: '9fa91c0a-1111-2222-3333-444455556666', name: 'Connectwise' },
        { id: '53c6b1e2-e1fa-4cae-94ed-32a1c016e2d7', name: 'Household' },
        { id: '2e9ee3a1-4864-467c-9147-2c2092915be1', name: 'Personal' },
      ],
      nextCursor: null,
    });
  });

  it('lists task lists as lean {id, name} rows sorted by name', () => {
    const page = JSON.parse(runTool('list', { type: 'task_lists' }, {}));
    expect(page.results.map((row: Record<string, unknown>) => Object.keys(row))).toEqual([
      ['id', 'name'], ['id', 'name'], ['id', 'name'],
    ]);
    expect(page.results.map((row: { name: string }) => row.name)).toEqual(['groceries', 'Murmur8', 'Shopping']);
  });

  it('pages calendars with a name cursor when pageSize is smaller than the set', () => {
    const first = JSON.parse(runTool('list', { type: 'calendars', pageSize: 2 }, {}));
    expect(first.results.map((row: { name: string }) => row.name)).toEqual(['Connectwise', 'Household']);
    expect(first.nextCursor).toBe(encodeListCursor('Household', '53c6b1e2-e1fa-4cae-94ed-32a1c016e2d7'));
    const second = JSON.parse(runTool('list', { type: 'calendars', pageSize: 2, cursor: first.nextCursor }, {}));
    expect(second).toEqual({ results: [{ id: '2e9ee3a1-4864-467c-9147-2c2092915be1', name: 'Personal' }], nextCursor: null });
  });

  it('answers an empty search in the SearchTool shape', () => {
    expect(runTool('search', { query: 'anything' }, {})).toBe('{"TotalCount":0,"Items":[]}');
  });

  it('answers an empty calendar_events list with the truncated flag the handler always sends', () => {
    expect(runTool('list', { type: 'calendar_events' }, {})).toBe('{"results":[],"nextCursor":null,"truncated":false}');
  });
});

// Thirty active tasks (the last five InProcess) and three done ones, newest first by updatedAt.
function boardTasks(): MockTask[] {
  const tasks: MockTask[] = [];
  for (let index = 0; index < 33; index += 1) {
    const minute = String(59 - index).padStart(2, '0');
    let status: MockTask['status'] = 'NeedsAction';
    if (index >= 25 && index < 30) status = 'InProcess';
    if (index === 30 || index === 31) status = 'Completed';
    if (index === 32) status = 'Cancelled';
    tasks.push({
      id: `task-${String(index + 1).padStart(2, '0')}`,
      title: `Board task ${index + 1}`,
      taskListId: index % 2 === 0 ? MURMUR8_ID : GROCERIES_ID,
      status,
      updatedAt: `2026-06-20T14:${minute}:00.418263Z`,
    });
  }
  return tasks;
}

function listTasks(args: Record<string, unknown>, tasks: MockTask[] = boardTasks()): any {
  return JSON.parse(runTool('list', { type: 'tasks', ...args }, { list: paginated(tasks) }));
}

describe('paginated (list tool, ListTool + CursorPaginator rules)', () => {
  it('serves the production default page of 20, newest first, with a production cursor', () => {
    const first = listTasks({});
    expect(first.results).toHaveLength(20);
    expect(first.results[0]).toEqual({ id: 'task-01', title: 'Board task 1', status: 'NeedsAction', priority: 0 });
    expect(first.nextCursor).toBe(encodeListCursor('2026-06-20T14:40:00.418263Z', 'task-20'));
    const second = listTasks({ cursor: first.nextCursor });
    expect(second.results.map((row: { id: string }) => row.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `task-${String(index + 21).padStart(2, '0')}`),
    );
    expect(second.nextCursor).toBeNull();
  });

  it('honours pageSize and clamps it to 1..100; a non-number pageSize falls back to 20', () => {
    expect(listTasks({ pageSize: 100 }).results).toHaveLength(30);
    expect(listTasks({ pageSize: 100 }).nextCursor).toBeNull();
    expect(listTasks({ pageSize: 7 }).results).toHaveLength(7);
    expect(listTasks({ pageSize: 0 }).results).toHaveLength(1);
    expect(listTasks({ pageSize: '50' }).results).toHaveLength(20);
    const many = Array.from({ length: 130 }, (_, index) => ({
      id: `bulk-${String(index).padStart(3, '0')}`, title: `Bulk ${index}`, taskListId: MURMUR8_ID,
      updatedAt: '2026-06-20T14:00:00.418263Z',
    }));
    const clamped = listTasks({ pageSize: 500 }, many);
    expect(clamped.results).toHaveLength(100);
    expect(clamped.nextCursor).toBe(encodeListCursor('2026-06-20T14:00:00.418263Z', 'bulk-099'));
    expect(listTasks({ pageSize: 500, cursor: clamped.nextCursor }, many).results).toHaveLength(30);
  });

  it('defaults to active tasks and filters an exact status; an unknown status is the active default', () => {
    expect(listTasks({ pageSize: 100 }).results.every((row: { status: string }) =>
      row.status === 'NeedsAction' || row.status === 'InProcess')).toBe(true);
    expect(listTasks({ status: 'InProcess' }).results).toHaveLength(5);
    expect(listTasks({ status: 'NeedsAction', pageSize: 100 }).results).toHaveLength(25);
    expect(listTasks({ status: 'needsaction', pageSize: 100 }).results).toHaveLength(30);
  });

  it('rejects All/Completed/Cancelled without a taskListId with the production message, and scopes them with one', () => {
    const rejected = runTool('list', { type: 'tasks', status: 'Completed' }, { list: paginated(boardTasks()) });
    expect(rejected).toBe(
      '{"error":"Listing all/completed/cancelled tasks requires a taskListId (one board at a time). '
      + 'Call list with type:\\u0022task_lists\\u0022 to get board IDs, then retry with taskListId set. '
      + 'To see your active tasks across all boards, omit status."}',
    );
    expect(listTasks({ status: 'Completed', taskListId: MURMUR8_ID }).results.map((row: { id: string }) => row.id)).toEqual(['task-31']);
    expect(listTasks({ status: 'All', taskListId: GROCERIES_ID, pageSize: 100 }).results).toHaveLength(16);
    expect(listTasks({ taskListId: GROCERIES_ID, pageSize: 100 }).results).toHaveLength(15);
  });

  it('restarts at page 1 on an unreadable cursor, as ListCursor.TryDecode does', () => {
    expect(listTasks({ cursor: '5' }).results[0].id).toBe('task-01');
    expect(listTasks({ cursor: 20 }).results[0].id).toBe('task-01');
  });

  it('never writes a null field inside a row, but always writes the envelope nextCursor', () => {
    const text = runTool('list', { type: 'tasks' }, { list: paginated([{ id: 't', title: 'x', taskListId: MURMUR8_ID }]) });
    expect(text).toBe('{"results":[{"id":"t","title":"x","status":"NeedsAction","priority":0}],"nextCursor":null}');
  });
});

describe('murmur8Mocks (a small seeded world behind list and search)', () => {
  const world = murmur8Mocks({
    tasks: [{ id: 'task-r1', title: 'Review the quarterly numbers', taskListId: MURMUR8_ID }],
    events: [
      { id: 'evt-soon', title: 'Dentist appointment', calendarId: PERSONAL_ID, start: '2026-06-29T14:00:00Z', end: '2026-06-29T15:00:00Z' },
      { id: 'evt-later', title: 'Doctor appointment', calendarId: HOUSEHOLD_ID, start: '2026-07-06T19:30:00Z', end: '2026-07-06T20:30:00Z' },
    ],
    reminders: [
      { id: 'rem-pending', title: 'call the bank', remindAt: '2026-06-26T21:00:00Z' },
      { id: 'rem-fired', title: 'old one', remindAt: '2026-06-20T21:00:00Z', status: 'Fired' },
    ],
  });

  it('searches tasks and events (never reminders) in the SearchTool shape, honouring types', () => {
    const all = JSON.parse(runTool('search', { query: 'appointment' }, world));
    expect(all.TotalCount).toBe(3);
    expect(all.Items.map((item: { EntityType: string }) => item.EntityType)).toEqual(['TaskItem', 'CalendarEvent', 'CalendarEvent']);
    expect(all.Items[1].Subtitle).toBe('Personal · Jun 29, 2026 10:00 AM');
    const events = JSON.parse(runTool('search', { query: 'appointment', types: 'CalendarEvent' }, world));
    expect(events.TotalCount).toBe(2);
    expect(JSON.parse(runTool('search', { query: 'a' }, world))).toEqual({ TotalCount: 0, Items: [] });
  });

  it('escapes the Subtitle middle dot the way System.Text.Json writes it', () => {
    expect(runTool('search', { query: 'dentist', types: 'CalendarEvent' }, world)).toContain('"Personal \\u00B7 Jun 29, 2026 10:00 AM"');
  });

  it('lists calendar events in the default now..now+7 days window, or an explicit local or UTC range', () => {
    const upcoming = JSON.parse(runTool('list', { type: 'calendar_events' }, world));
    expect(upcoming.results.map((row: { id: string }) => row.id)).toEqual(['evt-soon']);
    expect(upcoming.truncated).toBe(false);
    expect(upcoming.results[0].localStart).toBe('2026-06-29T10:00:00');
    const local = JSON.parse(runTool('list', { type: 'calendar_events', start: '2026-07-06T00:00:00', end: '2026-07-07T00:00:00' }, world));
    expect(local.results.map((row: { id: string }) => row.id)).toEqual(['evt-later']);
    const dayBoundary = JSON.parse(runTool('list', { type: 'calendar_events', start: '2026-06-29T14:30:00Z', end: '2026-06-29T14:45:00Z' }, world));
    expect(dayBoundary.results.map((row: { id: string }) => row.id)).toEqual(['evt-soon']);
    const byCalendar = JSON.parse(runTool('list', { type: 'calendar_events', calendarId: HOUSEHOLD_ID, start: '2026-07-01' }, world));
    expect(byCalendar.results.map((row: { id: string }) => row.id)).toEqual(['evt-later']);
  });

  it('lists pending reminders by default and requires a created range for history statuses', () => {
    const pending = JSON.parse(runTool('list', { type: 'reminders' }, world));
    expect(pending.results.map((row: { id: string }) => row.id)).toEqual(['rem-pending']);
    expect(pending.results[0].localRemindAt).toBe('2026-06-26T17:00:00');
    expect(JSON.parse(runTool('list', { type: 'reminders', status: 'fired' }, world)).error).toContain('requires a date range');
    const all = JSON.parse(runTool('list', { type: 'reminders', status: 'All', createdAfter: '2026-01-01T00:00:00Z' }, world));
    expect(all.results).toHaveLength(2);
  });

  it('keeps the default calendars and task lists behind a seeded world', () => {
    expect(JSON.parse(runTool('list', { type: 'calendars' }, world)).results).toHaveLength(3);
    expect(JSON.parse(runTool('list', { type: 'task_lists' }, world)).results).toHaveLength(3);
  });
});

describe('errorOnce', () => {
  it('errorOnce errors first then returns', () => {
    const fn = errorOnce({ code: 500, message: 'boom' }, { ok: true });
    expect(runTool('list', {}, { list: fn })).toContain('boom');
    expect(runTool('list', {}, { list: fn })).toContain('ok');
  });
});
