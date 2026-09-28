// Expected values are copied from murmur8's own shape tests (tests/Murmur8.Application.Tests:
// TaskAiShapeTests, ListCalendarEventsForAiQueryHandlerTests, ReminderAiShapeTests,
// SearchQueryHandlerTests, ListCursorTests) so the mocks match what production serializes.
import { describe, it, expect } from 'vitest';
import {
  calendarEventListRow,
  calendarEventSearchItem,
  decodeListCursor,
  encodeListCursor,
  localDueDate,
  localWallClock,
  reminderListRow,
  searchResult,
  taskListRow,
  taskSearchItem,
  toSystemTextJson,
} from './murmur8-results.js';

const MURMUR8_LIST_ID = '87697694-3927-462a-b15b-21e2008c0597';
const PERSONAL_CALENDAR_ID = '2e9ee3a1-4864-467c-9147-2c2092915be1';

describe('local time (UserLocalClock, America/Detroit)', () => {
  it('converts a UTC instant to the local wall clock with no Z and no offset', () => {
    expect(localWallClock('2026-09-28T17:00:00Z')).toBe('2026-09-28T13:00:00');
    expect(localWallClock('2026-09-28T00:00:00Z')).toBe('2026-09-27T20:00:00');
    expect(localWallClock('2026-12-17T14:30:00Z')).toBe('2026-12-17T09:30:00');
  });

  it('keeps a floating due date (UTC midnight) as its own date, led by the weekday', () => {
    expect(localDueDate('2026-09-28T00:00:00Z')).toBe('Monday 2026-09-28');
    expect(localDueDate('2026-10-15T00:00:00Z')).toBe('Thursday 2026-10-15');
  });

  it('converts a due instant to the local wall clock, led by the local weekday', () => {
    expect(localDueDate('2026-09-29T01:30:00Z')).toBe('Monday 2026-09-28T21:30:00');
  });
});

describe('list cursor (ListCursor.Encode)', () => {
  it('is base64 of the compact {"s":sortValue,"i":id} JSON', () => {
    const token = encodeListCursor('2026-06-20T14:32:00.418263Z', 'task-1');
    expect(Buffer.from(token, 'base64').toString('utf8')).toBe('{"s":"2026-06-20T14:32:00.418263Z","i":"task-1"}');
    expect(decodeListCursor(token)).toEqual({ sortValue: '2026-06-20T14:32:00.418263Z', id: 'task-1' });
  });

  it('decodes null, blank, malformed or incomplete tokens to null (the handler restarts at page 1)', () => {
    expect(decodeListCursor(null)).toBeNull();
    expect(decodeListCursor('   ')).toBeNull();
    expect(decodeListCursor('20')).toBeNull();
    expect(decodeListCursor('not-base64-!@#$%')).toBeNull();
    expect(decodeListCursor(Buffer.from('{"i":"someId"}').toString('base64'))).toBeNull();
    expect(decodeListCursor(Buffer.from('{"s":"value"}').toString('base64'))).toBeNull();
    expect(decodeListCursor(42)).toBeNull();
  });
});

describe('task list row (TaskAiListView through the omit-null list envelope)', () => {
  it('omits dueDate and the local fields when the task has no due date', () => {
    const row = taskListRow({ id: 't1', title: 'Renew car registration', taskListId: MURMUR8_LIST_ID });
    expect(Object.keys(row)).toEqual(['id', 'title', 'status', 'priority']);
    expect(row).toEqual({ id: 't1', title: 'Renew car registration', status: 'NeedsAction', priority: 0 });
  });

  it('carries dueDate plus localDueDate and localTimeZone, in the view property order', () => {
    const row = taskListRow({
      id: 't1', title: 'Renew car registration', taskListId: MURMUR8_LIST_ID, dueDate: '2026-09-28T00:00:00Z',
    });
    expect(Object.keys(row)).toEqual(['id', 'title', 'status', 'dueDate', 'priority', 'localDueDate', 'localTimeZone']);
    expect(row.localDueDate).toBe('Monday 2026-09-28');
    expect(row.localTimeZone).toBe('America/Detroit');
  });
});

describe('calendar event list row (CalendarEventAiListView)', () => {
  it('carries the UTC occurrence and the local wall clock', () => {
    const row = calendarEventListRow({
      id: 'e1', title: 'Guardians Standup', calendarId: PERSONAL_CALENDAR_ID,
      start: '2026-09-28T17:00:00Z', end: '2026-09-28T17:30:00Z',
    });
    expect(Object.keys(row)).toEqual([
      'id', 'title', 'occurrenceStart', 'occurrenceEnd', 'isAllDay', 'localStart', 'localEnd', 'localTimeZone',
    ]);
    expect(row).toMatchObject({
      occurrenceStart: '2026-09-28T17:00:00Z', isAllDay: false,
      localStart: '2026-09-28T13:00:00', localEnd: '2026-09-28T13:30:00', localTimeZone: 'America/Detroit',
    });
  });

  it('writes an all-day value as its floating date, not shifted by the offset', () => {
    const row = calendarEventListRow({
      id: 'e2', title: 'Holiday', calendarId: PERSONAL_CALENDAR_ID,
      start: '2026-09-28T00:00:00Z', end: '2026-09-29T00:00:00Z', isAllDay: true,
    });
    expect(row.localStart).toBe('2026-09-28T00:00:00');
    expect(row.localEnd).toBe('2026-09-29T00:00:00');
  });
});

describe('reminder list row (ReminderAiListRow)', () => {
  it('carries revision and the local remind time, in the row property order', () => {
    const row = reminderListRow({ id: 'reminder1', title: 'Put the recycling out', remindAt: '2026-09-28T00:45:00Z' });
    expect(Object.keys(row)).toEqual(['id', 'revision', 'title', 'remindAt', 'localRemindAt', 'localTimeZone']);
    expect(row).toMatchObject({ revision: 0, localRemindAt: '2026-09-27T20:45:00', localTimeZone: 'America/Detroit' });
  });
});

describe('search result (SearchTool.ExecuteAsync)', () => {
  it('is {TotalCount, Items} with PascalCase items in the anonymous-object order, nulls written', () => {
    const result = searchResult([
      taskSearchItem({ id: 't1', title: 'Review the deploy script', taskListId: MURMUR8_LIST_ID }),
      { EntityType: 'Album', EntityId: 'a1', Title: 'Beach', Subtitle: null, ParentName: null, Score: 0.5 },
    ]);
    expect(Object.keys(result)).toEqual(['TotalCount', 'Items']);
    expect(result.TotalCount).toBe(2);
    expect(Object.keys(result.Items[0])).toEqual(['EntityType', 'EntityId', 'Title', 'Subtitle', 'ParentName', 'Score']);
    expect(result.Items[0]).toEqual({
      EntityType: 'TaskItem', EntityId: 't1', Title: 'Review the deploy script',
      Subtitle: 'Murmur8', ParentName: 'Murmur8', Score: 1,
    });
    expect(toSystemTextJson(result)).toContain('"Subtitle":null,"ParentName":null');
  });

  it('writes the parent and the LOCAL date (and time for timed events and due instants) in the Subtitle', () => {
    const event = (start: string, isAllDay = false): string | null =>
      calendarEventSearchItem({ id: 'e', title: 'x', calendarId: PERSONAL_CALENDAR_ID, start, end: start, isAllDay }).Subtitle;
    expect(event('2026-09-29T00:30:00Z')).toBe('Personal · Sep 28, 2026 8:30 PM');
    expect(event('2026-09-28T00:00:00Z', true)).toBe('Personal · Sep 28, 2026');

    const task = (dueDate: string): string | null =>
      taskSearchItem({ id: 't', title: 'x', taskListId: MURMUR8_LIST_ID, dueDate }).Subtitle;
    expect(task('2026-09-28T00:00:00Z')).toBe('Murmur8 · Sep 28, 2026');
    expect(task('2026-09-29T01:30:00Z')).toBe('Murmur8 · Sep 28, 2026 9:30 PM');
  });
});

describe('toSystemTextJson (JavaScriptEncoder.Default escaping)', () => {
  it('writes compact JSON, escaping HTML-sensitive and non-ASCII characters as uppercase \\uXXXX', () => {
    expect(toSystemTextJson({ t: `Mom's · <b> & "x" +1 é \`q\` \\ \n` })).toBe(
      '{"t":"Mom\\u0027s \\u00B7 \\u003Cb\\u003E \\u0026 \\u0022x\\u0022 \\u002B1 \\u00E9 \\u0060q\\u0060 \\\\ \\n"}',
    );
  });

  it('round-trips through JSON.parse and drops undefined members like JSON.stringify', () => {
    const value = { a: [1, 'Personal · Jun 29', null, true], b: undefined, c: { d: 0.75 } };
    const text = toSystemTextJson(value);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(value)));
    expect(text).not.toContain('"b"');
  });
});
