// Production result shapes for the murmur8 read tools, as the deployed API serializes them
// (murmur8 50cd9628). Mocks build their payloads from here so every case sees what the live
// agent sees. Ground truth, all under murmur8 src/Murmur8.Application:
// - search: AI/Tools/SearchTool.cs serializes `new { TotalCount, Items = { EntityType, EntityId,
//   Title, Subtitle, ParentName, Score } }` with DEFAULT options: PascalCase, nulls written.
//   Search/SearchQueryHandler.cs BuildSubtitle writes "Parent · local date" (timed events and task
//   due instants add the local time). Infrastructure/Search/SearchRepository.cs searches tasks,
//   calendar events, files, directories, albums, task lists, calendars, described photos and email;
//   task lists, calendars and albums have a NULL parent. Reminders are not searchable.
// - list: AI/Tools/AiListQueryExtensions.ToAiListResult writes `{ results, nextCursor }` with
//   CamelCaseOmitNull: null row fields are omitted, the envelope nextCursor is always written.
//   calendar_events (ListCalendarEventsForAiQueryHandler) writes `{ results, nextCursor: null,
//   truncated }` with plain CamelCase; its row's local fields carry JsonIgnore(WhenWritingNull).
// - rows: Tasks/Queries/Ai/TaskAiViews.cs (TaskAiListView), Calendar/Queries/Ai/CalendarAiViews.cs
//   and CalendarEventAiViews.cs, Tasks/Queries/Ai/TaskListAiViews.cs,
//   Reminders/Queries/ListRemindersForAi (ReminderAiListRow).
// - local time: AI/Tools/UserLocalClock.cs, from the user's saved timezone (the pinned clock's).
// - cursor: AI/Tools/ListCursor.cs, base64 of the compact JSON {"s": sortValue, "i": id}.
// - text: System.Text.Json's default JavaScriptEncoder escapes HTML-sensitive and non-ASCII
//   characters; the Hugo MCP path sends that raw text (McpToolInvocation GetRawText).

import responses from '../fixtures/responses-fixture.json' with { type: 'json' };
import { USER_TIMEZONE } from './pinned-clock.js';

/** murmur8 Domain TaskStatus names, as the list row writes them. */
export type TaskStatus = 'NeedsAction' | 'InProcess' | 'Completed' | 'Cancelled';

/** murmur8 Domain ReminderStatus names. */
export type ReminderStatus = 'Pending' | 'Fired' | 'Dismissed' | 'Cancelled';

/** A task as a case seeds it. Only the fields production derives a read result from. */
export interface MockTask {
  id: string;
  title: string;
  taskListId: string;
  /** Defaults to NeedsAction. */
  status?: TaskStatus;
  /** Defaults to 0 (no priority). */
  priority?: number;
  /** Stored UTC value; a portal due date is a floating date at UTC midnight. */
  dueDate?: string;
  /** The list sort key (UpdatedAt, descending), as System.Text.Json writes the DateTime. */
  updatedAt?: string;
}

/** A calendar event occurrence as a case seeds it. */
export interface MockEvent {
  id: string;
  title: string;
  calendarId: string;
  /** UTC instant (for an all-day event, the floating date at UTC midnight). */
  start: string;
  end: string;
  isAllDay?: boolean;
}

/** A reminder as a case seeds it. */
export interface MockReminder {
  id: string;
  title: string;
  /** UTC instant. */
  remindAt: string;
  /** Defaults to 0, the revision of a reminder that was never edited. */
  revision?: number;
  /** Defaults to Pending. */
  status?: ReminderStatus;
  /** The list sort key (UpdatedAt, descending). */
  updatedAt?: string;
}

/** A directory (DirectoryItem) as a case seeds it. */
export interface MockDirectory {
  id: string;
  name: string;
  /** The containing directory; absent for a top-level directory. */
  parentDirectoryId?: string;
  /** UTC instant; the search date. */
  createdAt: string;
}

/** A file (FileItem) as a case seeds it. */
export interface MockFile {
  id: string;
  name: string;
  /** The containing directory; absent for a file at the root. */
  directoryId?: string;
  /** UTC instant; the search date. */
  createdAt: string;
}

/** A photo album as a case seeds it. */
export interface MockAlbum {
  id: string;
  name: string;
  /** UTC instant; the search date. */
  createdAt: string;
}

/** A described photo (PhotoMetadata joined to its FileItem) as a case seeds it. */
export interface MockPhoto {
  /** The FileItem id. */
  id: string;
  /** The FileItem name (the search Title). */
  name: string;
  /** An album the photo is in; absent when it is in none. */
  albumId?: string;
  /** UTC instant the description was written (PhotoMetadata.DescribedAt); the search date. */
  describedAt?: string;
}

/** An email message as a case seeds it. */
export interface MockEmail {
  id: string;
  /** Absent for a message with no subject (searched as "(no subject)"). */
  subject?: string;
  /** The owning mailbox's (or shared mailbox's) address: the search parent. */
  mailboxAddress: string;
  /** UTC instant (EmailMessage.Date); the search date. */
  date: string;
}

/** One SearchTool item, in the anonymous-object property order. */
export interface SearchItem {
  EntityType: string;
  EntityId: string;
  Title: string;
  Subtitle: string | null;
  ParentName: string | null;
  Score: number;
}

/** The SearchTool envelope. */
export interface SearchResult {
  TotalCount: number;
  Items: SearchItem[];
}

/** A `{ id, name }` list row (CalendarAiListView, TaskListAiListView). */
export interface NamedRow {
  id: string;
  name: string;
}

/** Default UpdatedAt for a seeded entity that does not name one. */
export const DEFAULT_UPDATED_AT = '2026-06-20T14:32:00.418263Z';

/** The fixture's calendars as `list {type:'calendars'}` rows. */
export const MOCK_CALENDARS: readonly NamedRow[] = responses.calendars;

/** The fixture's task lists as `list {type:'task_lists'}` rows. */
export const MOCK_TASK_LISTS: readonly NamedRow[] = responses.taskLists;

// CreatedAt of the fixture task lists and calendars: the search date (Subtitle) of a TaskList or
// Calendar row. groceries, Murmur8, Shopping and Personal carry the CreatedAt of the same-named
// production rows (serve murmur8-postgres, read 2026-10-01); Household has no production row and
// production's Connectwise was created after the pinned clock, so those two are set before it.
const FIXTURE_CONTAINER_CREATED_AT: Record<string, string> = {
  '7101b4ff-d49d-4117-a055-d3a67e9971d9': '2026-03-22T00:01:12.050955Z',
  '87697694-3927-462a-b15b-21e2008c0597': '2026-03-13T12:39:55.154043Z',
  '8fb60e48-04f4-4f14-bbb3-ca55eed87eb6': '2026-03-19T03:24:27.8651Z',
  '2e9ee3a1-4864-467c-9147-2c2092915be1': '2026-03-18T05:00:16.825945Z',
  '53c6b1e2-e1fa-4cae-94ed-32a1c016e2d7': '2026-04-02T15:10:44.512337Z',
  '9fa91c0a-1111-2222-3333-444455556666': '2026-05-11T13:02:09.118204Z',
};

// Some cases file a task under the Personal CALENDAR's id (and m8-active-02 names that container
// "Personal"); search resolves the parent name from here, so name it the way those cases do.
const EXTRA_PARENT_NAMES: Record<string, string> = { '2e9ee3a1-4864-467c-9147-2c2092915be1': 'Personal' };

function nameOf(rows: readonly NamedRow[], id: string): string | null {
  const found = rows.find((row) => row.id === id);
  if (found) return found.name;
  return EXTRA_PARENT_NAMES[id] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Local time (UserLocalClock)
// ---------------------------------------------------------------------------------------------

interface LocalParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  weekday: string;
}

function localParts(utcIso: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: USER_TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
  }).formatToParts(new Date(utcIso));
  const byType: Record<string, string> = {};
  for (const part of parts) byType[part.type] = part.value;
  return {
    year: byType.year, month: byType.month, day: byType.day,
    hour: byType.hour, minute: byType.minute, second: byType.second, weekday: byType.weekday,
  };
}

/** The stored value's own date and time, read as written (a floating value is not converted). */
function floatingParts(storedIso: string): LocalParts {
  const date = new Date(storedIso);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(date);
  return {
    year: String(date.getUTCFullYear()), month: pad(date.getUTCMonth() + 1), day: pad(date.getUTCDate()),
    hour: pad(date.getUTCHours()), minute: pad(date.getUTCMinutes()), second: pad(date.getUTCSeconds()), weekday,
  };
}

function wallClock(parts: LocalParts): string {
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/** UserLocalClock.ToWallClock: the user's local wall clock, "yyyy-MM-ddTHH:mm:ss". */
export function localWallClock(utcIso: string): string {
  return wallClock(localParts(utcIso));
}

/** UserLocalClock.IsFloatingDate: a stored value at exactly UTC midnight names a day, not an instant. */
export function isFloatingDate(storedIso: string): boolean {
  const date = new Date(storedIso);
  return date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0
    && date.getUTCMilliseconds() === 0;
}

/** UserLocalClock.ToLocalDueDate: "Monday 2026-09-28" (floating) or "Monday 2026-09-28T21:30:00". */
export function localDueDate(storedIso: string): string {
  if (isFloatingDate(storedIso)) {
    const parts = floatingParts(storedIso);
    return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day}`;
  }
  const parts = localParts(storedIso);
  return `${parts.weekday} ${wallClock(parts)}`;
}

/** UserLocalClock.ToCalendarWallClock: all-day values are written as stored, others converted. */
function calendarWallClock(storedIso: string, isAllDay: boolean): string {
  if (isAllDay) return wallClock(floatingParts(storedIso));
  return localWallClock(storedIso);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** C# "MMM d, yyyy" (InvariantCulture). */
function subtitleDate(parts: LocalParts): string {
  return `${MONTHS[Number(parts.month) - 1]} ${Number(parts.day)}, ${parts.year}`;
}

/** C# "MMM d, yyyy h:mm tt" (InvariantCulture). */
function subtitleDateTime(parts: LocalParts): string {
  const hour = Number(parts.hour);
  const meridiem = hour < 12 ? 'AM' : 'PM';
  let twelveHour = hour % 12;
  if (twelveHour === 0) twelveHour = 12;
  return `${subtitleDate(parts)} ${twelveHour}:${parts.minute} ${meridiem}`;
}

/** SearchQueryHandler.BuildSubtitle: "Parent · date", either part optional, null when neither. */
function subtitle(parentName: string | null, date: string | null): string | null {
  const parts: string[] = [];
  if (parentName !== null) parts.push(parentName);
  if (date !== null) parts.push(date);
  if (parts.length === 0) return null;
  return parts.join(' \u00b7 ');
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

/** A `list {type:'tasks'}` row: TaskAiListView with null members omitted. */
export function taskListRow(task: MockTask): Record<string, unknown> {
  const row: Record<string, unknown> = { id: task.id, title: task.title, status: task.status ?? 'NeedsAction' };
  if (task.dueDate !== undefined) row.dueDate = task.dueDate;
  row.priority = task.priority ?? 0;
  if (task.dueDate !== undefined) {
    row.localDueDate = localDueDate(task.dueDate);
    row.localTimeZone = USER_TIMEZONE;
  }
  return row;
}

/** A `list {type:'calendar_events'}` row: CalendarEventAiListView. */
export function calendarEventListRow(event: MockEvent): Record<string, unknown> {
  const isAllDay = event.isAllDay ?? false;
  return {
    id: event.id,
    title: event.title,
    occurrenceStart: event.start,
    occurrenceEnd: event.end,
    isAllDay,
    localStart: calendarWallClock(event.start, isAllDay),
    localEnd: calendarWallClock(event.end, isAllDay),
    localTimeZone: USER_TIMEZONE,
  };
}

/** A `list {type:'reminders'}` row: ReminderAiListRow. */
export function reminderListRow(reminder: MockReminder): Record<string, unknown> {
  return {
    id: reminder.id,
    revision: reminder.revision ?? 0,
    title: reminder.title,
    remindAt: reminder.remindAt,
    localRemindAt: localWallClock(reminder.remindAt),
    localTimeZone: USER_TIMEZONE,
  };
}

/** A search item for a task: the parent is its board, the date its due date. */
export function taskSearchItem(task: MockTask, score: number = 1): SearchItem {
  const parentName = nameOf(MOCK_TASK_LISTS, task.taskListId);
  let date: string | null = null;
  if (task.dueDate !== undefined) {
    date = isFloatingDate(task.dueDate)
      ? subtitleDate(floatingParts(task.dueDate))
      : subtitleDateTime(localParts(task.dueDate));
  }
  return {
    EntityType: 'TaskItem', EntityId: task.id, Title: task.title,
    Subtitle: subtitle(parentName, date), ParentName: parentName, Score: score,
  };
}

/** A search item for a calendar event: the parent is its calendar, the date its start. */
export function calendarEventSearchItem(event: MockEvent, score: number = 1): SearchItem {
  const parentName = nameOf(MOCK_CALENDARS, event.calendarId);
  const date = event.isAllDay
    ? subtitleDate(floatingParts(event.start))
    : subtitleDateTime(localParts(event.start));
  return {
    EntityType: 'CalendarEvent', EntityId: event.id, Title: event.title,
    Subtitle: subtitle(parentName, date), ParentName: parentName, Score: score,
  };
}

/** Every other entity type's search date: the user's local date only ("MMM d, yyyy"). */
function localSubtitleDate(utcIso: string | undefined): string | null {
  if (utcIso === undefined) return null;
  return subtitleDate(localParts(utcIso));
}

/** A search item whose parent and date production builds the same way for every non-timed type. */
function plainSearchItem(
  entityType: string, entityId: string, title: string, parentName: string | null, date: string | undefined, score: number,
): SearchItem {
  return {
    EntityType: entityType, EntityId: entityId, Title: title,
    Subtitle: subtitle(parentName, localSubtitleDate(date)), ParentName: parentName, Score: score,
  };
}

function fixtureContainerCreatedAt(id: string): string {
  return FIXTURE_CONTAINER_CREATED_AT[id] ?? DEFAULT_UPDATED_AT;
}

/** A search item for a task list: no parent (the SQL selects NULL), dated by its CreatedAt. */
export function taskListSearchItem(taskList: NamedRow, score: number = 1): SearchItem {
  return plainSearchItem('TaskList', taskList.id, taskList.name, null, fixtureContainerCreatedAt(taskList.id), score);
}

/** A search item for a calendar: no parent (the SQL selects NULL), dated by its CreatedAt. */
export function calendarSearchItem(calendar: NamedRow, score: number = 1): SearchItem {
  return plainSearchItem('Calendar', calendar.id, calendar.name, null, fixtureContainerCreatedAt(calendar.id), score);
}

/** A search item for a file: the parent is its directory (null at the root), the date its CreatedAt. */
export function fileSearchItem(file: MockFile, directories: readonly MockDirectory[], score: number = 1): SearchItem {
  const directory = directories.find((candidate) => candidate.id === file.directoryId);
  return plainSearchItem('FileItem', file.id, file.name, directory?.name ?? null, file.createdAt, score);
}

/** A search item for a directory: the parent is its parent directory (null at the top), the date its CreatedAt. */
export function directorySearchItem(
  directory: MockDirectory, directories: readonly MockDirectory[], score: number = 1,
): SearchItem {
  const parent = directories.find((candidate) => candidate.id === directory.parentDirectoryId);
  return plainSearchItem('DirectoryItem', directory.id, directory.name, parent?.name ?? null, directory.createdAt, score);
}

/** A search item for an album: no parent (the SQL selects NULL), dated by its CreatedAt. */
export function albumSearchItem(album: MockAlbum, score: number = 1): SearchItem {
  return plainSearchItem('Album', album.id, album.name, null, album.createdAt, score);
}

/** A search item for a described photo: the parent is an album it is in, the date its DescribedAt. */
export function photoSearchItem(photo: MockPhoto, albums: readonly MockAlbum[], score: number = 1): SearchItem {
  const album = albums.find((candidate) => candidate.id === photo.albumId);
  return plainSearchItem('Photo', photo.id, photo.name, album?.name ?? null, photo.describedAt, score);
}

/** A search item for an email: the parent is its mailbox address, the title "(no subject)" when it has none. */
export function emailSearchItem(email: MockEmail, score: number = 1): SearchItem {
  return plainSearchItem('EmailMessage', email.id, email.subject ?? '(no subject)', email.mailboxAddress, email.date, score);
}

/** The SearchTool envelope around already-ranked items. */
export function searchResult(items: SearchItem[]): SearchResult {
  return { TotalCount: items.length, Items: items };
}

// ---------------------------------------------------------------------------------------------
// Cursor (ListCursor)
// ---------------------------------------------------------------------------------------------

/** ListCursor.Encode: base64 of `{"s":sortValue,"i":id}` as System.Text.Json writes it. */
export function encodeListCursor(sortValue: string | number, id: string): string {
  return Buffer.from(toSystemTextJson({ s: sortValue, i: id }), 'utf8').toString('base64');
}

/** ListCursor.TryDecode: null for anything that is not a base64 `{"s":…,"i":"…"}` token. */
export function decodeListCursor(token: unknown): { sortValue: string | number; id: string } | null {
  if (typeof token !== 'string' || token.trim() === '') return null;
  if (token.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(token)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const payload = parsed as Record<string, unknown>;
  if (!('s' in payload) || typeof payload.i !== 'string') return null;
  if (typeof payload.s !== 'string' && typeof payload.s !== 'number') return null;
  return { sortValue: payload.s, id: payload.i };
}

// ---------------------------------------------------------------------------------------------
// System.Text.Json text
// ---------------------------------------------------------------------------------------------

// JavaScriptEncoder.Default allows printable Basic Latin except these HTML-sensitive characters.
const HTML_SENSITIVE = new Set(['"', '&', "'", '+', '<', '>', '`']);

const SHORT_ESCAPES: Record<string, string> = {
  '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f',
};

function escapeCodeUnits(character: string): string {
  let escaped = '';
  for (let index = 0; index < character.length; index += 1) {
    escaped += '\\u' + character.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0');
  }
  return escaped;
}

function encodeString(text: string): string {
  let encoded = '"';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (Object.hasOwn(SHORT_ESCAPES, character)) {
      encoded += SHORT_ESCAPES[character];
    } else if (code >= 0x20 && code <= 0x7e && !HTML_SENSITIVE.has(character)) {
      encoded += character;
    } else {
      encoded += escapeCodeUnits(character);
    }
  }
  return encoded + '"';
}

/**
 * Compact JSON exactly as System.Text.Json writes it with the default encoder: HTML-sensitive
 * characters (" & ' + < > `) and every non-ASCII character become uppercase \uXXXX escapes
 * ("·" is \u00B7, an apostrophe \u0027). Undefined members are dropped, like JSON.stringify.
 */
export function toSystemTextJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return encodeString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return '[' + value.map((item) => toSystemTextJson(item)).join(',') + ']';
  if (typeof value === 'object') {
    const members = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .map(([key, member]) => `${encodeString(key)}:${toSystemTextJson(member)}`);
    return '{' + members.join(',') + '}';
  }
  return 'null';
}
