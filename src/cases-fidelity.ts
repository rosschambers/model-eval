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
import { paginated, errorOnce, murmur8Mocks } from './mock-engine.js';
import { TASK_BOARD } from './task-board-fixture.js';

const PERSONAL_ID = '2e9ee3a1-4864-467c-9147-2c2092915be1';
const GROCERIES_ID = '7101b4ff-d49d-4117-a055-d3a67e9971d9';

const CALENDAR_NAMES = ['Household', 'Personal', 'Connectwise'];

// A mock where every search and task lookup comes back empty — there is no
// matching task to act on, so the honest move is to say so, not to invent a
// completion. Calendars and task lists still list as the fixture's.
const emptySearchMock: MockMap = murmur8Mocks();

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
    // Forty active tasks: the production default page of 20 ends with a nextCursor to follow.
    mocks: { list: paginated(TASK_BOARD) },
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
