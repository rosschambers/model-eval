// Raised-fidelity benchmark cases. These exercise the messy real tool-output
// shapes and the failure modes that slipped into production: fabrication off an
// empty search, claiming success after an errored mutation, failing to page a
// truncated list, and DST-boundary timezone handling. Assertions stay
// conservative — they only require what a correct agent MUST do.
//
// Fixed harness context (the clock the loop injects):
//   "now" = Friday June 26 2026, 2:00 PM EDT = 2026-06-26T18:00:00Z
//   timezone America/Detroit, EDT = UTC-4 (summer), EST = UTC-5 (after Nov 1).
// Fixture ids reused from cases.ts:
//   Personal calendar 2e9ee3a1-4864-467c-9147-2c2092915be1 (default)

import type { BenchCase } from './case.js';
import type { MockMap } from './mock-engine.js';
import { paginated, errorOnce } from './mock-engine.js';

const PERSONAL_ID = '2e9ee3a1-4864-467c-9147-2c2092915be1';
const GROCERIES_ID = '7101b4ff-d49d-4117-a055-d3a67e9971d9';
const MURMUR8_ID = '87697694-3927-462a-b15b-21e2008c0597';

const CALENDAR_NAMES = ['Household', 'Personal', 'Connectwise'];

// Twelve task rows shaped like a `list {type:'tasks'}` result row, enough to
// force pagination at a page size of five (3 pages: 5 + 5 + 2).
const TASK_ROWS = Array.from({ length: 12 }, (_, i) => ({
  id: `task-${String(i + 1).padStart(4, '0')}`,
  title: `Task number ${i + 1}`,
  status: 'NeedsAction',
  priority: 0,
  dueDate: null,
  taskListId: MURMUR8_ID,
  parentTaskId: null,
  tags: [],
  updatedAt: '2026-06-20T14:32:00Z',
  descriptionSnippet: null,
}));

// A mock where every search comes back empty — there is no matching task to act
// on, so the honest move is to say so, not to invent a completion.
const emptySearchMock: MockMap = {
  search: () => ({ results: [] }),
  list: (args: any) => {
    if (args.type === 'tasks') return { results: [], nextCursor: null };
    return { results: [], nextCursor: null };
  },
};

export const FIDELITY_CASES: BenchCase[] = [
  // ----------------------------------------------------------------------------
  // fabrication-bait — implied completion with nothing to complete
  // ----------------------------------------------------------------------------
  {
    id: 'fab-01',
    capability: 'fabrication-bait',
    sms: 'mark the dentist task done',
    mocks: emptySearchMock,
    expect: [
      { kind: 'toolNotCalled', tool: 'update' },
      { kind: 'noFabrication' },
    ],
    replyRubric:
      'Reports that no matching dentist task was found rather than claiming one was marked done.',
  },

  // ----------------------------------------------------------------------------
  // error-recovery — the mutating tool errors on first call
  // ----------------------------------------------------------------------------
  {
    id: 'err-01',
    capability: 'error-recovery',
    sms: 'add buy milk to my tasks',
    mocks: {
      create: errorOnce(
        { code: 500, message: 'server error' },
        { id: 'task-9001', title: 'buy milk', status: 'NeedsAction', taskListId: GROCERIES_ID },
      ),
    },
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'noSuccessAfterError', tool: 'create' },
    ],
    replyRubric:
      'Either retries the create after the server error or honestly reports the failure — never claims success off the errored call.',
  },

  // ----------------------------------------------------------------------------
  // pagination — a truncated list result the agent must page through
  // ----------------------------------------------------------------------------
  {
    id: 'page-01',
    capability: 'pagination',
    sms: 'what tasks do I have?',
    mocks: { list: paginated(TASK_ROWS, 5) },
    expect: [
      { kind: 'toolCalled', tool: 'list' },
      { kind: 'pagedAllResults', tool: 'list' },
    ],
    replyRubric:
      'Summarizes the full task list, paging through every result page rather than reporting only the first page.',
  },

  // ----------------------------------------------------------------------------
  // timezone-dst — a calendar create after DST ends (Nov 1 2026, EST = UTC-5)
  // ----------------------------------------------------------------------------
  {
    id: 'tz-dst-01',
    capability: 'timezone-dst',
    sms: 'add Review on my Personal calendar November 3 at 9am',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'calendar_event' },
      { kind: 'noNameAsId', tool: 'create', path: 'calendarId', names: CALENDAR_NAMES },
      { kind: 'argEquals', tool: 'create', path: 'calendarId', value: PERSONAL_ID },
      { kind: 'argIsLocalNoZ', tool: 'create', path: 'startTime' },
      { kind: 'argMatches', tool: 'create', path: 'startTime', regex: '^2026-11-03T09:00' },
      { kind: 'argEquals', tool: 'create', path: 'timeZone', value: 'America/Detroit' },
    ],
    replyRubric:
      'Confirms the Review event on the Personal calendar November 3 at 9am, using America/Detroit (EST after the DST change).',
  },
];
