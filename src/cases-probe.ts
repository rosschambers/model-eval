// Held-out PROBE cases. They exercise the same capabilities as the main case sets
// (bare-weekday and relative-date resolution, clarify-on-ambiguity, pagination,
// memory follow-ups, resolving names to ids, task-list selection) with fresh
// phrasings and fresh entities that no training corpus is allowed to contain
// (crucible fingerprints them). The main sets are partly overlapped by legacy
// training data, so their absolute scores are optimistic; these probes measure
// how far behavior generalizes beyond what was trained.
//
// Fixed harness context (the clock the loop injects):
//   "now" = Friday June 26 2026, 2:00 PM EDT = 2026-06-26T18:00:00Z
//   timezone America/Detroit, EDT = UTC-4 (summer). Upcoming weekdays:
//   Sun 06-28, Mon 06-29, Tue 06-30, Wed 07-01, Thu 07-02.

import type { BenchCase } from './case.js';
import { paginated } from './mock-engine.js';
import {
  CALENDAR_NAMES,
  CONNECTWISE_ID,
  HOUSEHOLD_ID,
  LIST_NAMES,
  MURMUR8_ID,
  PERSONAL_ID,
  SHOPPING_ID,
  reminderLookupMock,
  twoTaskMock,
} from './cases.js';

// Twelve open errands, enough to force three pages at a page size of five.
const ERRAND_ROWS = Array.from({ length: 12 }, (_, index) => ({
  id: `task-errand-${String(index + 1).padStart(2, '0')}`,
  title: `Errand ${index + 1}`,
  status: 'NeedsAction',
  priority: 0,
  dueDate: null,
  taskListId: MURMUR8_ID,
  parentTaskId: null,
  tags: [],
  updatedAt: '2026-06-20T14:32:00Z',
  descriptionSnippet: null,
}));

export const PROBE_CASES: BenchCase[] = [
  // bare weekday → nearest upcoming occurrence
  {
    id: 'probe-weekday-01',
    capability: 'relative-date',
    sms: 'put a haircut on my Personal calendar Monday at 11am',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'calendar_event' },
      { kind: 'noNameAsId', tool: 'create', path: 'calendarId', names: CALENDAR_NAMES },
      { kind: 'argEquals', tool: 'create', path: 'calendarId', value: PERSONAL_ID },
      { kind: 'argIsLocalNoZ', tool: 'create', path: 'startTime' },
      { kind: 'argMatches', tool: 'create', path: 'startTime', regex: '^2026-06-29T11:00' },
      { kind: 'argEquals', tool: 'create', path: 'timeZone', value: 'America/Detroit' },
    ],
    replyRubric: 'Confirms the haircut on Monday June 29 at 11am on the Personal calendar.',
  },
  {
    id: 'probe-weekday-02',
    capability: 'relative-date',
    sms: 'brunch with the neighbors Sunday at 10:30am, household calendar please',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'calendar_event' },
      { kind: 'argEquals', tool: 'create', path: 'calendarId', value: HOUSEHOLD_ID },
      { kind: 'argIsLocalNoZ', tool: 'create', path: 'startTime' },
      { kind: 'argMatches', tool: 'create', path: 'startTime', regex: '^2026-06-28T10:30' },
    ],
    replyRubric: 'Confirms brunch on Sunday June 28 at 10:30am on the Household calendar.',
  },
  {
    id: 'probe-weekday-03',
    capability: 'relative-date',
    sms: 'remind me Wednesday at 7pm to pay rent',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'reminder' },
      { kind: 'argInstant', tool: 'create', path: 'remindAt', value: '2026-07-01T23:00:00Z' },
    ],
    replyRubric: 'Confirms a rent reminder for Wednesday July 1 at 7pm.',
  },
  {
    id: 'probe-relative-04',
    capability: 'relative-date',
    sms: 'ping me tomorrow at 7:15am to move the car',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'reminder' },
      { kind: 'argInstant', tool: 'create', path: 'remindAt', value: '2026-06-27T11:15:00Z' },
    ],
    replyRubric: 'Confirms a move-the-car reminder for tomorrow (Saturday June 27) at 7:15am.',
  },
  {
    id: 'probe-multi-05',
    capability: 'relative-date',
    sms: 'book a tire rotation Thursday at 8:30am and remind me the night before',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'calendar_event' },
      { kind: 'argIsLocalNoZ', tool: 'create', path: 'startTime' },
      { kind: 'argMatches', tool: 'create', path: 'startTime', regex: '^2026-07-02T08:30' },
      { kind: 'noFabrication' },
    ],
    replyRubric: 'Confirms the tire rotation on Thursday July 2 at 8:30am and a reminder the evening before.',
  },

  // two matches → ask which, never act on a guess
  {
    id: 'probe-ambig-06',
    capability: 'search-disambiguation',
    sms: 'cross off the plumber call',
    mocks: twoTaskMock(
      { id: 'task-plumb-1', title: 'Call the plumber about the sink', taskListId: MURMUR8_ID },
      { id: 'task-plumb-2', title: 'Call the plumber about the invoice', taskListId: MURMUR8_ID },
    ),
    expect: [
      { kind: 'toolCalledAnyOf', tools: ['search', 'list'] },
      { kind: 'toolNotCalled', tool: 'update' },
    ],
    replyRubric: 'Asks which plumber call is meant rather than completing either.',
  },
  {
    id: 'probe-ambig-07',
    capability: 'search-disambiguation',
    sms: 'get rid of the filters task',
    mocks: twoTaskMock(
      { id: 'task-filter-1', title: 'Order furnace filters', taskListId: MURMUR8_ID },
      { id: 'task-filter-2', title: 'Order fridge water filters', taskListId: MURMUR8_ID },
    ),
    expect: [
      { kind: 'toolCalledAnyOf', tools: ['search', 'list'] },
      { kind: 'toolNotCalled', tool: 'delete' },
    ],
    replyRubric: 'Asks which filters task is meant rather than deleting either.',
  },

  // pagination
  {
    id: 'probe-page-08',
    capability: 'pagination',
    sms: "give me the full rundown of every open task I've got",
    mocks: { list: paginated(ERRAND_ROWS, 5) },
    expect: [
      { kind: 'toolCalled', tool: 'list' },
      { kind: 'pagedAllResults', tool: 'list' },
    ],
    replyRubric: 'Covers all twelve errands, paging through every result page.',
  },

  // memory follow-ups
  {
    id: 'probe-memory-09',
    capability: 'memory-followup',
    history: [
      { role: 'user', content: 'add sunscreen to my Shopping list' },
      { role: 'assistant', content: 'Added sunscreen to your Shopping list.' },
    ],
    sms: 'throw bug spray on there too',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'task' },
      { kind: 'noNameAsId', tool: 'create', path: 'taskListId', names: LIST_NAMES },
      { kind: 'argEquals', tool: 'create', path: 'taskListId', value: SHOPPING_ID },
      { kind: 'noFabrication' },
    ],
    replyRubric: 'Confirms bug spray was added to the same Shopping list.',
  },
  {
    id: 'probe-memory-10',
    capability: 'memory-followup',
    history: [
      { role: 'user', content: 'remind me to take my meds at 3pm today' },
      { role: 'assistant', content: 'Reminder set to take your meds at 3pm today.' },
    ],
    sms: 'actually make that 3:30',
    mocks: reminderLookupMock({ id: 'mock-rem-meds', title: 'take my meds', remindAt: '2026-06-26T19:00:00Z' }),
    expect: [
      { kind: 'toolCalled', tool: 'update' },
      { kind: 'argEquals', tool: 'update', path: 'reminderId', value: 'mock-rem-meds' },
      { kind: 'noFabrication' },
    ],
    replyRubric: 'Confirms the meds reminder moved to 3:30pm today.',
  },

  // names → ids
  {
    id: 'probe-lookup-11',
    capability: 'calendar-lookup',
    sms: 'is there anything on my Connectwise calendar Monday?',
    expect: [
      { kind: 'toolCalled', tool: 'list' },
      { kind: 'noNameAsId', tool: 'list', path: 'calendarId', names: CALENDAR_NAMES },
      { kind: 'toolNotCalled', tool: 'create' },
    ],
    replyRubric: `Reports what is on the Connectwise calendar (${CONNECTWISE_ID}) on Monday June 29 without creating anything.`,
  },
  {
    id: 'probe-list-12',
    capability: 'tasks-crud',
    sms: 'put "renew the car registration" on my Murmur8 list',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'task' },
      { kind: 'noNameAsId', tool: 'create', path: 'taskListId', names: LIST_NAMES },
      { kind: 'argEquals', tool: 'create', path: 'taskListId', value: MURMUR8_ID },
    ],
    replyRubric: 'Confirms the registration task was added to the Murmur8 list.',
  },
];
