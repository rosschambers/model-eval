// Payload fidelity across every case set: whatever a case's mocks return for `search` and `list`
// must be in the shape the deployed murmur8 sends, and the cases that exist to test clarifying or
// paging must still present something to clarify or page under the production rules.
import { describe, it, expect } from 'vitest';
import type { BenchCase } from './case.js';
import { CASES } from './cases.js';
import { FIDELITY_CASES } from './cases-fidelity.js';
import { MURMUR8_CASES } from './cases-murmur8.js';
import { PROBE_CASES } from './cases-probe.js';
import { runTool } from './mock-engine.js';

const ALL_CASES: BenchCase[] = [...CASES, ...FIDELITY_CASES, ...MURMUR8_CASES, ...PROBE_CASES];
const PERSONAL_ID = '2e9ee3a1-4864-467c-9147-2c2092915be1';
const SEARCH_ITEM_KEYS = ['EntityType', 'EntityId', 'Title', 'Subtitle', 'ParentName', 'Score'];

function caseById(id: string): BenchCase {
  const found = ALL_CASES.find((benchCase) => benchCase.id === id);
  if (!found) throw new Error('missing case ' + id);
  return found;
}

function call(benchCase: BenchCase, tool: string, args: Record<string, unknown>): any {
  return JSON.parse(runTool(tool, args, benchCase.mocks ?? {}));
}

function hasNullMember(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some((item) => hasNullMember(item));
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some((item) => hasNullMember(item));
  return false;
}

describe('search payloads (every case)', () => {
  for (const benchCase of ALL_CASES) {
    it(`${benchCase.id}: search answers {TotalCount, Items} with SearchTool item fields`, () => {
      const result = call(benchCase, 'search', { query: 'appointment' });
      expect(Object.keys(result)).toEqual(['TotalCount', 'Items']);
      expect(result.TotalCount).toBe(result.Items.length);
      for (const item of result.Items) expect(Object.keys(item)).toEqual(SEARCH_ITEM_KEYS);
    });
  }
});

describe('list payloads (every case)', () => {
  const LIST_TYPES = ['tasks', 'task_lists', 'calendars', 'calendar_events', 'reminders'];
  for (const benchCase of ALL_CASES) {
    it(`${benchCase.id}: list rows omit nulls, carry local time and always send nextCursor`, () => {
      for (const type of LIST_TYPES) {
        const page = call(benchCase, 'list', { type, pageSize: 100 });
        expect(page, `${type}`).toHaveProperty('nextCursor');
        expect(Array.isArray(page.results), `${type}`).toBe(true);
        for (const row of page.results) {
          expect(hasNullMember(row), `${type} row ${JSON.stringify(row)}`).toBe(false);
          if (type === 'calendar_events') expect(row).toHaveProperty('localStart');
          if (type === 'reminders') expect(row).toHaveProperty('localRemindAt');
          if (type === 'tasks' && 'dueDate' in row) expect(row).toHaveProperty('localDueDate');
        }
      }
    });
  }
});

describe('ambig-03 presents two appointments to the lookup the model makes', () => {
  const ambiguous = caseById('ambig-03');

  it('lists two appointments on calendar_events, with or without the Personal calendar id', () => {
    for (const args of [{ type: 'calendar_events' }, { type: 'calendar_events', calendarId: PERSONAL_ID }]) {
      const titles = call(ambiguous, 'list', args).results.map((row: { title: string }) => row.title);
      expect(titles).toEqual(['Dentist appointment', 'Doctor appointment']);
    }
  });

  it('searches two calendar events', () => {
    const result = call(ambiguous, 'search', { query: 'appointment' });
    expect(result.TotalCount).toBe(2);
    expect(result.Items.map((item: { EntityType: string }) => item.EntityType)).toEqual(['CalendarEvent', 'CalendarEvent']);
  });
});

describe('twoTaskMock clarify cases search the two tasks in the SearchTool shape', () => {
  for (const id of ['ambig-01', 'ambig-02', 'm8-ambig-01', 'm8-ambig-02', 'probe-ambig-06', 'probe-ambig-07']) {
    it(`${id}: two TaskItem matches under their board name`, () => {
      const result = call(caseById(id), 'search', { query: 'x'.repeat(4) });
      expect(result.TotalCount).toBe(2);
      for (const item of result.Items) {
        expect(item.EntityType).toBe('TaskItem');
        expect(item.ParentName).toBe('Murmur8');
      }
    });
  }
});

describe('paging cases need a second page at the production default page size', () => {
  for (const id of ['page-01', 'm8-page-01']) {
    it(`${id}: default page of 20 returns a cursor that reaches the rest, then null`, () => {
      const pagingCase = caseById(id);
      const first = call(pagingCase, 'list', { type: 'tasks' });
      expect(first.results).toHaveLength(20);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = call(pagingCase, 'list', { type: 'tasks', cursor: first.nextCursor });
      expect(second.results.length).toBeGreaterThan(0);
      expect(second.nextCursor).toBeNull();
      const everything = call(pagingCase, 'list', { type: 'tasks', pageSize: 100 });
      expect(everything.results).toHaveLength(first.results.length + second.results.length);
      expect(everything.nextCursor).toBeNull();
    });
  }
});
