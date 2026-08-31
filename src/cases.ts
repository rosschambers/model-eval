// Benchmark cases for the local-model evaluation harness. Each BenchCase is one
// SMS the model must handle against the deterministic mock engine. Assertions are
// deliberately conservative: they only require what a correct agent MUST do, and
// avoid over-constraining valid alternate phrasings or tool sequences.
//
// Fixed harness context (the clock the loop injects):
//   "now" = Friday June 26 2026, 2:00 PM EDT = 2026-06-26T18:00:00Z
//   timezone America/Detroit, EDT = UTC-4 (summer).
// Fixture ids:
//   Calendars:  Personal    2e9ee3a1-4864-467c-9147-2c2092915be1 (default)
//               Household       53c6b1e2-e1fa-4cae-94ed-32a1c016e2d7
//               Connectwise 9fa91c0a-1111-2222-3333-444455556666
//   Task lists: groceries   7101b4ff-d49d-4117-a055-d3a67e9971d9
//               Murmur8     87697694-3927-462a-b15b-21e2008c0597
//               Shopping    8fb60e48-04f4-4f14-bbb3-ca55eed87eb6

import type { BenchCase } from './case.js';
import type { MockMap } from './mock-engine.js';

const PERSONAL_ID = '2e9ee3a1-4864-467c-9147-2c2092915be1';
const HOUSEHOLD_ID = '53c6b1e2-e1fa-4cae-94ed-32a1c016e2d7';
const CONNECTWISE_ID = '9fa91c0a-1111-2222-3333-444455556666';

const GROCERIES_ID = '7101b4ff-d49d-4117-a055-d3a67e9971d9';
const MURMUR8_ID = '87697694-3927-462a-b15b-21e2008c0597';
const SHOPPING_ID = '8fb60e48-04f4-4f14-bbb3-ca55eed87eb6';

const CALENDAR_NAMES = ['Household', 'Personal', 'Connectwise'];
const LIST_NAMES = ['groceries', 'Murmur8', 'Shopping'];

// The fixture's calendars, shaped like a `list {type:'calendars'}` result row.
const CALENDARS = [
  { id: PERSONAL_ID, name: 'Personal' },
  { id: HOUSEHOLD_ID, name: 'Household' },
  { id: CONNECTWISE_ID, name: 'Connectwise' },
];

// A mock where `search` and `list {type:'tasks'}` return a single matching task,
// so an implied-completion request has an unambiguous target to mark done.
function singleTaskMock(task: Record<string, unknown>): MockMap {
  return {
    search: () => ({ results: [task] }),
    list: (args: any) => {
      if (args.type === 'tasks') return { results: [task], nextCursor: null };
      // Fall through to defaults for calendars / task_lists by re-deriving them.
      if (args.type === 'calendars') return { results: CALENDARS, nextCursor: null };
      if (args.type === 'task_lists') {
        return {
          results: [
            { id: GROCERIES_ID, name: 'groceries' },
            { id: MURMUR8_ID, name: 'Murmur8' },
            { id: SHOPPING_ID, name: 'Shopping' },
          ],
          nextCursor: null,
        };
      }
      return { results: [], nextCursor: null };
    },
  };
}

// A mock where `search` returns TWO matching tasks — the honest move is to ask
// which one, not to guess and act destructively.
function twoTaskMock(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
): MockMap {
  return {
    search: () => ({ results: [first, second] }),
    list: (args: any) => {
      if (args.type === 'tasks') {
        return { results: [first, second], nextCursor: null };
      }
      return { results: [], nextCursor: null };
    },
  };
}

// A mock where listing/searching the named calendar surfaces ONE seeded event,
// so a follow-up ("move that", "cancel it") has a real id to update/delete.
function eventLookupMock(opts: { calendarId: string; event: Record<string, unknown> }): MockMap {
  return {
    search: () => ({ results: [opts.event] }),
    list: (args: any) => {
      if (args.type === 'calendars') return { results: CALENDARS, nextCursor: null };
      if (args.type === 'calendar_events') {
        const match = !args.calendarId || args.calendarId === opts.calendarId;
        return { results: match ? [opts.event] : [], nextCursor: null };
      }
      return { results: [], nextCursor: null };
    },
  };
}

// A mock where looking up reminders surfaces ONE seeded reminder. This case
// tests id-resolution discipline (resolve the real id, don't fabricate one), so
// the reminder is surfaced via BOTH list and search — a correct agent shouldn't
// fail merely for reaching for `search` to find it.
function reminderLookupMock(reminder: Record<string, unknown>): MockMap {
  return {
    search: () => ({ results: [reminder] }),
    list: (args: any) => {
      if (args.type === 'reminders') return { results: [reminder], nextCursor: null };
      return { results: [], nextCursor: null };
    },
  };
}

export const CASES: BenchCase[] = [
  // ----------------------------------------------------------------------------
  // calendar-create-tz
  // ----------------------------------------------------------------------------
  {
    id: 'cal-tz-01',
    capability: 'calendar-create-tz',
    sms: 'add Dentist to my Household calendar June 28 at 3pm',
    expect: [
      { kind: 'callOrder', before: 'list', after: 'create' },
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'calendar_event' },
      { kind: 'noNameAsId', tool: 'create', path: 'calendarId', names: CALENDAR_NAMES },
      { kind: 'argEquals', tool: 'create', path: 'calendarId', value: HOUSEHOLD_ID },
      { kind: 'argIsLocalNoZ', tool: 'create', path: 'startTime' },
      { kind: 'argMatches', tool: 'create', path: 'startTime', regex: '^2026-06-28T15:00' },
      { kind: 'argEquals', tool: 'create', path: 'timeZone', value: 'America/Detroit' },
    ],
    replyRubric: 'Confirms the Dentist event was added to the Household calendar on June 28 at 3pm.',
  },
  {
    id: 'cal-tz-02',
    capability: 'calendar-create-tz',
    sms: 'put a Connectwise standup on my Connectwise calendar tomorrow at 9am',
    expect: [
      { kind: 'callOrder', before: 'list', after: 'create' },
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'calendar_event' },
      { kind: 'noNameAsId', tool: 'create', path: 'calendarId', names: CALENDAR_NAMES },
      { kind: 'argEquals', tool: 'create', path: 'calendarId', value: CONNECTWISE_ID },
      { kind: 'argIsLocalNoZ', tool: 'create', path: 'startTime' },
      { kind: 'argMatches', tool: 'create', path: 'startTime', regex: '^2026-06-27T09:00' },
      { kind: 'argEquals', tool: 'create', path: 'timeZone', value: 'America/Detroit' },
    ],
    replyRubric: 'Confirms the standup was added to the Connectwise calendar tomorrow at 9am.',
  },
  {
    id: 'cal-tz-03',
    capability: 'calendar-create-tz',
    sms: 'schedule lunch with Sam at noon today',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'calendar_event' },
      { kind: 'noNameAsId', tool: 'create', path: 'calendarId', names: CALENDAR_NAMES },
      { kind: 'argIsLocalNoZ', tool: 'create', path: 'startTime' },
      { kind: 'argMatches', tool: 'create', path: 'startTime', regex: '^2026-06-26T12:00' },
      { kind: 'argEquals', tool: 'create', path: 'timeZone', value: 'America/Detroit' },
    ],
    replyRubric: 'Confirms lunch with Sam was added today at noon.',
  },
  {
    id: 'cal-tz-04',
    capability: 'calendar-create-tz',
    sms: 'add a 7pm dinner reservation on my Personal calendar this Saturday',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'calendar_event' },
      { kind: 'noNameAsId', tool: 'create', path: 'calendarId', names: CALENDAR_NAMES },
      { kind: 'argEquals', tool: 'create', path: 'calendarId', value: PERSONAL_ID },
      { kind: 'argIsLocalNoZ', tool: 'create', path: 'startTime' },
      { kind: 'argMatches', tool: 'create', path: 'startTime', regex: '^2026-06-27T19:00' },
      { kind: 'argEquals', tool: 'create', path: 'timeZone', value: 'America/Detroit' },
    ],
    replyRubric: 'Confirms the 7pm dinner reservation was added to the Personal calendar this Saturday.',
  },

  // ----------------------------------------------------------------------------
  // calendar-lookup
  // ----------------------------------------------------------------------------
  {
    id: 'cal-look-01',
    capability: 'calendar-lookup',
    sms: "what's on my Connectwise calendar this weekend?",
    expect: [
      { kind: 'toolCalled', tool: 'list' },
      { kind: 'noNameAsId', tool: 'list', path: 'calendarId', names: CALENDAR_NAMES },
      { kind: 'toolNotCalled', tool: 'create' },
    ],
    replyRubric: 'Summarizes (or reports none) the Connectwise calendar events for this weekend without creating anything.',
  },
  {
    id: 'cal-look-02',
    capability: 'calendar-lookup',
    sms: 'do I have anything on my Household calendar tomorrow?',
    expect: [
      { kind: 'toolCalled', tool: 'list' },
      { kind: 'noNameAsId', tool: 'list', path: 'calendarId', names: CALENDAR_NAMES },
      { kind: 'toolNotCalled', tool: 'create' },
    ],
    replyRubric: 'Reports what is on the Household calendar tomorrow without creating anything.',
  },
  {
    id: 'cal-look-03',
    capability: 'calendar-lookup',
    sms: "what's my schedule today?",
    expect: [
      { kind: 'toolCalled', tool: 'list' },
      { kind: 'toolNotCalled', tool: 'create' },
    ],
    replyRubric: "Summarizes today's events across calendars without creating anything.",
  },
  {
    id: 'cal-look-04',
    capability: 'calendar-lookup',
    sms: 'when is my next meeting on the Connectwise calendar?',
    expect: [
      { kind: 'toolCalled', tool: 'list' },
      { kind: 'noNameAsId', tool: 'list', path: 'calendarId', names: CALENDAR_NAMES },
      { kind: 'toolNotCalled', tool: 'create' },
    ],
    replyRubric: 'Reports the next Connectwise meeting (or none) without creating anything.',
  },

  // ----------------------------------------------------------------------------
  // reminders-utc
  // ----------------------------------------------------------------------------
  {
    id: 'remind-01',
    capability: 'reminders-utc',
    sms: 'remind me to call mom at 6pm',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'reminder' },
      { kind: 'argInstant', tool: 'create', path: 'remindAt', value: '2026-06-26T22:00:00Z' },
    ],
    replyRubric: 'Confirms a reminder to call mom at 6pm today.',
  },
  {
    id: 'remind-02',
    capability: 'reminders-utc',
    sms: 'remind me to take out the trash at 8pm tonight',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'reminder' },
      { kind: 'argInstant', tool: 'create', path: 'remindAt', value: '2026-06-27T00:00:00Z' },
    ],
    replyRubric: 'Confirms a reminder to take out the trash at 8pm tonight.',
  },
  {
    id: 'remind-03',
    capability: 'reminders-utc',
    sms: 'remind me to submit the report tomorrow at 10am',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'reminder' },
      { kind: 'argInstant', tool: 'create', path: 'remindAt', value: '2026-06-27T14:00:00Z' },
    ],
    replyRubric: 'Confirms a reminder to submit the report tomorrow at 10am.',
  },
  {
    id: 'remind-04',
    capability: 'reminders-utc',
    sms: 'set a reminder to water the plants at 3pm today',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'reminder' },
      { kind: 'argInstant', tool: 'create', path: 'remindAt', value: '2026-06-26T19:00:00Z' },
    ],
    replyRubric: 'Confirms a reminder to water the plants at 3pm today.',
  },

  // ----------------------------------------------------------------------------
  // tasks-crud
  // ----------------------------------------------------------------------------
  {
    id: 'task-01',
    capability: 'tasks-crud',
    sms: 'add buy milk to my tasks',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'task' },
    ],
    replyRubric: 'Confirms a "buy milk" task was added.',
  },
  {
    id: 'task-02',
    capability: 'tasks-crud',
    sms: 'add finish the quarterly review to my Murmur8 list',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'task' },
      { kind: 'noNameAsId', tool: 'create', path: 'taskListId', names: LIST_NAMES },
      { kind: 'argEquals', tool: 'create', path: 'taskListId', value: MURMUR8_ID },
    ],
    replyRubric: 'Confirms the quarterly review task was added to the Murmur8 list.',
  },
  {
    id: 'task-03',
    capability: 'tasks-crud',
    sms: 'remind me to schedule the dentist — just add it as a task',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'task' },
    ],
    replyRubric: 'Confirms a task to schedule the dentist was added.',
  },
  {
    id: 'task-04',
    capability: 'tasks-crud',
    sms: 'add a task to renew my passport',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'task' },
    ],
    replyRubric: 'Confirms a task to renew the passport was added.',
  },

  // ----------------------------------------------------------------------------
  // complete-on-implication
  // ----------------------------------------------------------------------------
  {
    id: 'done-01',
    capability: 'complete-on-implication',
    sms: 'paid the water bill',
    mocks: singleTaskMock({
      id: 'task-water',
      title: 'Pay water bill',
      taskListId: PERSONAL_ID,
    }),
    expect: [
      { kind: 'toolCalled', tool: 'update' },
      { kind: 'argEquals', tool: 'update', path: 'status', value: 'Completed' },
      { kind: 'noFabrication' },
    ],
    replyRubric: 'Confirms the "Pay water bill" task was marked complete.',
  },
  {
    id: 'done-02',
    capability: 'complete-on-implication',
    sms: 'finished the quarterly review',
    mocks: singleTaskMock({
      id: 'task-review',
      title: 'Finish the quarterly review',
      taskListId: MURMUR8_ID,
    }),
    expect: [
      { kind: 'toolCalled', tool: 'update' },
      { kind: 'argMatches', tool: 'update', path: 'status', regex: 'Completed' },
      { kind: 'noFabrication' },
    ],
    replyRubric: 'Confirms the quarterly review task was marked complete.',
  },
  {
    id: 'done-03',
    capability: 'complete-on-implication',
    sms: 'submitted the expense report this morning',
    mocks: singleTaskMock({
      id: 'task-expense',
      title: 'Submit expense report',
      taskListId: MURMUR8_ID,
    }),
    expect: [
      { kind: 'toolCalled', tool: 'update' },
      { kind: 'argMatches', tool: 'update', path: 'status', regex: 'Completed' },
      { kind: 'noFabrication' },
    ],
    replyRubric: 'Confirms the expense report task was marked complete.',
  },
  {
    id: 'done-04',
    capability: 'complete-on-implication',
    sms: 'I already picked up the dry cleaning',
    mocks: singleTaskMock({
      id: 'task-cleaning',
      title: 'Pick up dry cleaning',
      taskListId: PERSONAL_ID,
    }),
    expect: [
      { kind: 'toolCalled', tool: 'update' },
      { kind: 'argMatches', tool: 'update', path: 'status', regex: 'Completed' },
      { kind: 'noFabrication' },
    ],
    replyRubric: 'Confirms the dry cleaning task was marked complete.',
  },

  // ----------------------------------------------------------------------------
  // lists-entity-lookup
  // ----------------------------------------------------------------------------
  {
    id: 'list-01',
    capability: 'lists-entity-lookup',
    sms: 'add eggs to my groceries list',
    expect: [
      { kind: 'callOrder', before: 'list', after: 'create' },
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'task' },
      { kind: 'noNameAsId', tool: 'create', path: 'taskListId', names: LIST_NAMES },
      { kind: 'argEquals', tool: 'create', path: 'taskListId', value: GROCERIES_ID },
    ],
    replyRubric: 'Confirms eggs were added to the groceries list.',
  },
  {
    id: 'list-02',
    capability: 'lists-entity-lookup',
    sms: 'put new running shoes on my Shopping list',
    expect: [
      { kind: 'callOrder', before: 'list', after: 'create' },
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'task' },
      { kind: 'noNameAsId', tool: 'create', path: 'taskListId', names: LIST_NAMES },
      { kind: 'argEquals', tool: 'create', path: 'taskListId', value: SHOPPING_ID },
    ],
    replyRubric: 'Confirms running shoes were added to the Shopping list.',
  },
  {
    id: 'list-03',
    capability: 'lists-entity-lookup',
    sms: 'add review the deploy script to my Murmur8 list',
    expect: [
      { kind: 'callOrder', before: 'list', after: 'create' },
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'task' },
      { kind: 'noNameAsId', tool: 'create', path: 'taskListId', names: LIST_NAMES },
      { kind: 'argEquals', tool: 'create', path: 'taskListId', value: MURMUR8_ID },
    ],
    replyRubric: 'Confirms the deploy-script task was added to the Murmur8 list.',
  },
  {
    id: 'list-04',
    capability: 'lists-entity-lookup',
    sms: 'add coffee beans to groceries',
    expect: [
      { kind: 'callOrder', before: 'list', after: 'create' },
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'task' },
      { kind: 'noNameAsId', tool: 'create', path: 'taskListId', names: LIST_NAMES },
      { kind: 'argEquals', tool: 'create', path: 'taskListId', value: GROCERIES_ID },
    ],
    replyRubric: 'Confirms coffee beans were added to the groceries list.',
  },

  // ----------------------------------------------------------------------------
  // search-disambiguation
  // ----------------------------------------------------------------------------
  {
    id: 'ambig-01',
    capability: 'search-disambiguation',
    sms: 'delete the review task',
    mocks: twoTaskMock(
      { id: 'task-r1', title: 'Review the quarterly numbers', taskListId: MURMUR8_ID },
      { id: 'task-r2', title: 'Review the deploy script', taskListId: MURMUR8_ID },
    ),
    expect: [
      { kind: 'toolCalledAnyOf', tools: ['search', 'list'] },
      { kind: 'toolNotCalled', tool: 'delete' },
    ],
    replyRubric: 'Asks which review task is meant rather than deleting either one.',
  },
  {
    id: 'ambig-02',
    capability: 'search-disambiguation',
    sms: 'mark the meeting prep done',
    mocks: twoTaskMock(
      { id: 'task-p1', title: 'Meeting prep for Household', taskListId: MURMUR8_ID },
      { id: 'task-p2', title: 'Meeting prep for Connectwise', taskListId: MURMUR8_ID },
    ),
    expect: [
      { kind: 'toolCalledAnyOf', tools: ['search', 'list'] },
      { kind: 'toolNotCalled', tool: 'update' },
    ],
    replyRubric: 'Asks which meeting-prep task is meant rather than completing either one.',
  },
  {
    id: 'ambig-03',
    capability: 'search-disambiguation',
    sms: 'cancel my appointment',
    mocks: twoTaskMock(
      { id: 'task-a1', title: 'Dentist appointment', taskListId: PERSONAL_ID },
      { id: 'task-a2', title: 'Doctor appointment', taskListId: PERSONAL_ID },
    ),
    expect: [
      { kind: 'toolCalledAnyOf', tools: ['search', 'list'] },
      { kind: 'toolNotCalled', tool: 'delete' },
    ],
    replyRubric: 'Asks which appointment is meant rather than deleting either one.',
  },

  // ----------------------------------------------------------------------------
  // memory-followup
  // ----------------------------------------------------------------------------
  {
    id: 'mem-01',
    capability: 'memory-followup',
    history: [
      { role: 'user', content: 'add Dentist to my Personal calendar today at 3pm' },
      { role: 'assistant', content: 'Done — Dentist is on your Personal calendar today at 3pm.' },
    ],
    sms: 'actually move that to 4pm',
    mocks: eventLookupMock({
      calendarId: PERSONAL_ID,
      event: {
        id: 'mock-evt-dentist',
        title: 'Dentist',
        calendarIds: [PERSONAL_ID],
        occurrenceStart: '2026-06-26T19:00:00Z',
        occurrenceEnd: '2026-06-26T20:00:00Z',
        isAllDay: false,
        isRecurring: false,
      },
    }),
    expect: [
      { kind: 'toolCalled', tool: 'update' },
      { kind: 'argEquals', tool: 'update', path: 'eventId', value: 'mock-evt-dentist' },
      { kind: 'noFabrication' },
    ],
    replyRubric: 'Confirms the Dentist event was moved to 4pm today.',
  },
  {
    id: 'mem-02',
    capability: 'memory-followup',
    history: [
      { role: 'user', content: 'add eggs to my groceries list' },
      { role: 'assistant', content: 'Added eggs to your groceries list.' },
    ],
    sms: 'add milk to that list too',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'task' },
      { kind: 'noNameAsId', tool: 'create', path: 'taskListId', names: LIST_NAMES },
      { kind: 'argEquals', tool: 'create', path: 'taskListId', value: GROCERIES_ID },
      { kind: 'noFabrication' },
    ],
    replyRubric: 'Confirms milk was added to the same groceries list.',
  },
  {
    id: 'mem-03',
    capability: 'memory-followup',
    history: [
      { role: 'user', content: 'remind me to call the bank at 5pm today' },
      { role: 'assistant', content: 'Reminder set to call the bank at 5pm today.' },
    ],
    sms: 'push that back an hour',
    mocks: reminderLookupMock({
      id: 'mock-rem-bank',
      title: 'call the bank',
      remindAt: '2026-06-26T21:00:00Z',
    }),
    expect: [
      { kind: 'toolCalled', tool: 'update' },
      { kind: 'argEquals', tool: 'update', path: 'reminderId', value: 'mock-rem-bank' },
      { kind: 'noFabrication' },
    ],
    replyRubric: 'Confirms the call-the-bank reminder was moved to 6pm today.',
  },
  {
    id: 'mem-04',
    capability: 'memory-followup',
    history: [
      { role: 'user', content: 'add Connectwise standup to my Connectwise calendar tomorrow at 9am' },
      { role: 'assistant', content: 'Added the standup to your Connectwise calendar tomorrow at 9am.' },
    ],
    sms: 'cancel it',
    mocks: eventLookupMock({
      calendarId: CONNECTWISE_ID,
      event: {
        id: 'mock-evt-standup',
        title: 'Connectwise standup',
        calendarIds: [CONNECTWISE_ID],
        occurrenceStart: '2026-06-27T13:00:00Z',
        occurrenceEnd: '2026-06-27T13:30:00Z',
        isAllDay: false,
        isRecurring: false,
      },
    }),
    expect: [
      { kind: 'toolCalled', tool: 'delete' },
      { kind: 'argEquals', tool: 'delete', path: 'eventId', value: 'mock-evt-standup' },
      { kind: 'noFabrication' },
    ],
    replyRubric: 'Confirms the standup was cancelled.',
  },

  // ----------------------------------------------------------------------------
  // multi-step
  // ----------------------------------------------------------------------------
  {
    id: 'multi-01',
    capability: 'multi-step',
    sms: 'add Dentist to my calendar Tuesday at 2pm and remind me an hour before',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'calendar_event' },
      { kind: 'argIsLocalNoZ', tool: 'create', path: 'startTime' },
      { kind: 'argMatches', tool: 'create', path: 'startTime', regex: '^2026-06-30T14:00' },
      { kind: 'argEquals', tool: 'create', path: 'timeZone', value: 'America/Detroit' },
    ],
    replyRubric: 'Confirms the Dentist event Tuesday at 2pm and a reminder an hour before.',
  },
  {
    id: 'multi-02',
    capability: 'multi-step',
    sms: 'schedule a haircut today at 5pm and set a reminder for it',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'calendar_event' },
      { kind: 'argIsLocalNoZ', tool: 'create', path: 'startTime' },
      { kind: 'argMatches', tool: 'create', path: 'startTime', regex: '^2026-06-26T17:00' },
      { kind: 'argEquals', tool: 'create', path: 'timeZone', value: 'America/Detroit' },
    ],
    replyRubric: 'Confirms the haircut event today at 5pm and a reminder for it.',
  },
  {
    id: 'multi-03',
    capability: 'multi-step',
    sms: 'put a team sync on my calendar tomorrow at 11am and remind me 15 minutes before',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'calendar_event' },
      { kind: 'argIsLocalNoZ', tool: 'create', path: 'startTime' },
      { kind: 'argMatches', tool: 'create', path: 'startTime', regex: '^2026-06-27T11:00' },
      { kind: 'argEquals', tool: 'create', path: 'timeZone', value: 'America/Detroit' },
    ],
    replyRubric: 'Confirms the team sync tomorrow at 11am and a reminder 15 minutes before.',
  },
  {
    id: 'multi-04',
    capability: 'multi-step',
    sms: 'add a book club event Saturday at 6pm and remind me two hours before',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'calendar_event' },
      { kind: 'argIsLocalNoZ', tool: 'create', path: 'startTime' },
      { kind: 'argMatches', tool: 'create', path: 'startTime', regex: '^2026-06-27T18:00' },
      { kind: 'argEquals', tool: 'create', path: 'timeZone', value: 'America/Detroit' },
    ],
    replyRubric: 'Confirms the book club event Saturday at 6pm and a reminder two hours before.',
  },

  // ----------------------------------------------------------------------------
  // sms-brevity
  // ----------------------------------------------------------------------------
  {
    id: 'brevity-01',
    capability: 'sms-brevity',
    sms: 'add Dentist to my calendar today at 3pm',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
    ],
    replyRubric: 'Confirms the dentist appointment was added; under 320 chars; no markdown or emoji; no step narration.',
  },
  {
    id: 'brevity-02',
    capability: 'sms-brevity',
    sms: 'add bananas to my groceries list',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
    ],
    replyRubric: 'Confirms bananas were added to groceries; under 320 chars; no markdown or emoji; no step narration.',
  },
  {
    id: 'brevity-03',
    capability: 'sms-brevity',
    sms: "what's on my calendar today?",
    expect: [
      { kind: 'toolCalled', tool: 'list' },
    ],
    replyRubric: "States today's events plainly (or that there are none); under 320 chars; no markdown or emoji; no step narration.",
  },
  {
    id: 'brevity-04',
    capability: 'sms-brevity',
    sms: 'remind me to call mom at 6pm',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
    ],
    replyRubric: 'Confirms the reminder to call mom at 6pm; under 320 chars; no markdown or emoji; no step narration.',
  },
];
