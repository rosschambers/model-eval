// Benchmark cases for the murmur8 in-app agent (portal chat). Same Murmur8 MCP
// tool surface and fixture ids as the Hugo cases, but phrased as multi-turn
// portal chat rather than terse SMS: full sentences, markdown allowed in replies,
// no 320-char cap, and NO n8n code-tool helpers (Parse_Date_Time / Convert_Time).
// Assertions stay conservative — they only require what a correct agent MUST do.
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
import { paginated, errorOnce } from './mock-engine.js';

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

const TASK_LISTS = [
  { id: GROCERIES_ID, name: 'groceries' },
  { id: MURMUR8_ID, name: 'Murmur8' },
  { id: SHOPPING_ID, name: 'Shopping' },
];

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

// A mock where `search` and `list {type:'tasks'}` return a single matching task,
// so an implied-completion request has an unambiguous target to mark done.
function singleTaskMock(task: Record<string, unknown>): MockMap {
  return {
    search: () => ({ results: [task] }),
    list: (args: any) => {
      if (args.type === 'tasks') return { results: [task], nextCursor: null };
      if (args.type === 'calendars') return { results: CALENDARS, nextCursor: null };
      if (args.type === 'task_lists') return { results: TASK_LISTS, nextCursor: null };
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
      if (args.type === 'tasks') return { results: [first, second], nextCursor: null };
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

// A mock where every search comes back empty — there is no matching task to act
// on, so the honest move is to say so, not to invent a completion.
const emptySearchMock: MockMap = {
  search: () => ({ results: [] }),
  list: (args: any) => {
    if (args.type === 'tasks') return { results: [], nextCursor: null };
    return { results: [], nextCursor: null };
  },
};

// Build a production-shaped <screen-context> block carrying a single <active-item>
// (the focused entity, WITH its real id) plus its containing route/container. The
// portal agent is meant to act on the active-item's id directly for deictic
// references, without a list/search round-trip.
function screenContextWithActiveItem(opts: {
  route: string;
  activeItemType: string;
  activeItemId: string;
  activeItemName: string;
  containerType?: string;
  containerId?: string;
  containerName?: string;
}): string {
  const lines = [`<screen-context route="${opts.route}" type="data">`];
  if (opts.containerType && opts.containerId && opts.containerName) {
    lines.push(
      `  <active-container type="${opts.containerType}" id="${opts.containerId}">${opts.containerName}</active-container>`,
    );
  }
  lines.push(
    `  <active-item type="${opts.activeItemType}" id="${opts.activeItemId}">${opts.activeItemName}</active-item>`,
  );
  lines.push('</screen-context>');
  return lines.join('\n');
}

// A mock that always surfaces one named task via search/list, so a NAMED-reference
// guardrail case has a real id to resolve to when it (correctly) looks up rather
// than blindly reusing the active-item.
function namedTaskMock(task: Record<string, unknown>): MockMap {
  return {
    search: () => ({ results: [task] }),
    list: (args: any) => {
      if (args.type === 'tasks') return { results: [task], nextCursor: null };
      if (args.type === 'task_lists') return { results: TASK_LISTS, nextCursor: null };
      if (args.type === 'calendars') return { results: CALENDARS, nextCursor: null };
      return { results: [], nextCursor: null };
    },
  };
}

export const MURMUR8_CASES: BenchCase[] = [
  // ----------------------------------------------------------------------------
  // calendar-create-tz
  // ----------------------------------------------------------------------------
  {
    id: 'm8-cal-tz-01',
    capability: 'calendar-create-tz',
    sms: 'Create a dentist appointment on my Household calendar June 28 at 3pm.',
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
    replyRubric:
      'Confirms the dentist appointment was added to the Household calendar on June 28 at 3pm. Markdown is fine; do not narrate tool steps.',
  },
  {
    id: 'm8-cal-tz-02',
    capability: 'calendar-create-tz',
    sms: 'Please add a standup to my Connectwise calendar tomorrow at 9am.',
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
    replyRubric:
      'Confirms the standup was added to the Connectwise calendar tomorrow at 9am. Markdown is fine; do not narrate tool steps.',
  },

  // ----------------------------------------------------------------------------
  // calendar-lookup
  // ----------------------------------------------------------------------------
  {
    id: 'm8-cal-look-01',
    capability: 'calendar-lookup',
    sms: "What's on my Connectwise calendar this weekend?",
    expect: [
      { kind: 'toolCalled', tool: 'list' },
      { kind: 'noNameAsId', tool: 'list', path: 'calendarId', names: CALENDAR_NAMES },
      { kind: 'toolNotCalled', tool: 'create' },
    ],
    replyRubric:
      'Summarizes (or reports none) the Connectwise calendar events for this weekend without creating anything. Markdown is fine.',
  },
  {
    id: 'm8-cal-look-02',
    capability: 'calendar-lookup',
    sms: 'Do I have anything scheduled today?',
    expect: [
      { kind: 'toolCalled', tool: 'list' },
      { kind: 'toolNotCalled', tool: 'create' },
    ],
    replyRubric:
      "Summarizes today's events across calendars without creating anything. Markdown is fine.",
  },

  // ----------------------------------------------------------------------------
  // reminders-utc
  // ----------------------------------------------------------------------------
  {
    id: 'm8-remind-01',
    capability: 'reminders-utc',
    sms: 'Remind me to call mom at 6pm.',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'reminder' },
      { kind: 'argInstant', tool: 'create', path: 'remindAt', value: '2026-06-26T22:00:00Z' },
    ],
    replyRubric: 'Confirms a reminder to call mom at 6pm today. Markdown is fine.',
  },
  {
    id: 'm8-remind-02',
    capability: 'reminders-utc',
    sms: 'Can you set a reminder to submit the report tomorrow at 10am?',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'reminder' },
      { kind: 'argInstant', tool: 'create', path: 'remindAt', value: '2026-06-27T14:00:00Z' },
    ],
    replyRubric: 'Confirms a reminder to submit the report tomorrow at 10am. Markdown is fine.',
  },

  // ----------------------------------------------------------------------------
  // tasks-crud
  // ----------------------------------------------------------------------------
  {
    id: 'm8-task-01',
    capability: 'tasks-crud',
    sms: 'Add "finish the quarterly review" to my Murmur8 list.',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'task' },
      { kind: 'noNameAsId', tool: 'create', path: 'taskListId', names: LIST_NAMES },
      { kind: 'argEquals', tool: 'create', path: 'taskListId', value: MURMUR8_ID },
    ],
    replyRubric:
      'Confirms the quarterly review task was added to the Murmur8 list. Markdown is fine.',
  },
  {
    id: 'm8-task-02',
    capability: 'tasks-crud',
    sms: 'Create a task to renew my passport.',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'task' },
    ],
    replyRubric: 'Confirms a task to renew the passport was added. Markdown is fine.',
  },

  // ----------------------------------------------------------------------------
  // complete-on-implication
  // ----------------------------------------------------------------------------
  {
    id: 'm8-done-01',
    capability: 'complete-on-implication',
    sms: 'I just paid the water bill.',
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
    replyRubric: 'Confirms the "Pay water bill" task was marked done. Markdown is fine.',
  },

  // ----------------------------------------------------------------------------
  // lists-entity-lookup
  // ----------------------------------------------------------------------------
  {
    id: 'm8-list-01',
    capability: 'lists-entity-lookup',
    sms: 'Add eggs to my groceries list.',
    expect: [
      { kind: 'callOrder', before: 'list', after: 'create' },
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'task' },
      { kind: 'noNameAsId', tool: 'create', path: 'taskListId', names: LIST_NAMES },
      { kind: 'argEquals', tool: 'create', path: 'taskListId', value: GROCERIES_ID },
    ],
    replyRubric: 'Confirms eggs were added to the groceries list. Markdown is fine.',
  },
  {
    id: 'm8-list-02',
    capability: 'lists-entity-lookup',
    sms: 'Put new running shoes on my Shopping list.',
    expect: [
      { kind: 'callOrder', before: 'list', after: 'create' },
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'task' },
      { kind: 'noNameAsId', tool: 'create', path: 'taskListId', names: LIST_NAMES },
      { kind: 'argEquals', tool: 'create', path: 'taskListId', value: SHOPPING_ID },
    ],
    replyRubric: 'Confirms running shoes were added to the Shopping list. Markdown is fine.',
  },

  // ----------------------------------------------------------------------------
  // search-disambiguation
  // ----------------------------------------------------------------------------
  {
    id: 'm8-ambig-01',
    capability: 'search-disambiguation',
    sms: 'Delete the review task.',
    mocks: twoTaskMock(
      { id: 'task-r1', title: 'Review the quarterly numbers', taskListId: MURMUR8_ID },
      { id: 'task-r2', title: 'Review the deploy script', taskListId: MURMUR8_ID },
    ),
    expect: [
      { kind: 'toolCalledAnyOf', tools: ['search', 'list'] },
      { kind: 'toolNotCalled', tool: 'delete' },
    ],
    replyRubric:
      'Asks which review task is meant rather than deleting either one. Markdown is fine.',
  },
  {
    id: 'm8-ambig-02',
    capability: 'search-disambiguation',
    sms: 'Mark the meeting prep done.',
    mocks: twoTaskMock(
      { id: 'task-p1', title: 'Meeting prep for Household', taskListId: MURMUR8_ID },
      { id: 'task-p2', title: 'Meeting prep for Connectwise', taskListId: MURMUR8_ID },
    ),
    expect: [
      { kind: 'toolCalledAnyOf', tools: ['search', 'list'] },
      { kind: 'toolNotCalled', tool: 'update' },
    ],
    replyRubric:
      'Asks which meeting-prep task is meant rather than completing either one. Markdown is fine.',
  },

  // ----------------------------------------------------------------------------
  // memory-followup
  // ----------------------------------------------------------------------------
  {
    id: 'm8-mem-01',
    capability: 'memory-followup',
    history: [
      { role: 'user', content: 'Add Dentist to my Personal calendar today at 3pm.' },
      { role: 'assistant', content: 'Done — Dentist is on your Personal calendar today at 3pm.' },
    ],
    sms: 'Actually, move that to 4pm.',
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
    replyRubric: 'Confirms the Dentist event was moved to 4pm today. Markdown is fine.',
  },
  {
    id: 'm8-mem-02',
    capability: 'memory-followup',
    history: [
      { role: 'user', content: 'Add eggs to my groceries list.' },
      { role: 'assistant', content: 'Added eggs to your groceries list.' },
    ],
    sms: 'Add milk to that list too.',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'task' },
      { kind: 'noNameAsId', tool: 'create', path: 'taskListId', names: LIST_NAMES },
      { kind: 'argEquals', tool: 'create', path: 'taskListId', value: GROCERIES_ID },
      { kind: 'noFabrication' },
    ],
    replyRubric: 'Confirms milk was added to the same groceries list. Markdown is fine.',
  },

  // ----------------------------------------------------------------------------
  // multi-step
  // ----------------------------------------------------------------------------
  {
    id: 'm8-multi-01',
    capability: 'multi-step',
    sms: 'Add Dentist to my calendar Tuesday at 2pm and remind me an hour before.',
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'argEquals', tool: 'create', path: 'type', value: 'calendar_event' },
      { kind: 'argIsLocalNoZ', tool: 'create', path: 'startTime' },
      { kind: 'argMatches', tool: 'create', path: 'startTime', regex: '^2026-06-30T14:00' },
      { kind: 'argEquals', tool: 'create', path: 'timeZone', value: 'America/Detroit' },
    ],
    replyRubric:
      'Confirms the Dentist event Tuesday at 2pm and a reminder an hour before. Markdown is fine.',
  },

  // ----------------------------------------------------------------------------
  // fabrication-bait — implied completion with nothing to complete
  // ----------------------------------------------------------------------------
  {
    id: 'm8-fab-01',
    capability: 'fabrication-bait',
    sms: 'Mark the dentist task done.',
    mocks: emptySearchMock,
    expect: [
      // toolNotCalled captures the discipline; noFabrication is dropped because
      // its completion-verb regex trips on the CORRECT reply ("no dentist task
      // found, so I haven't *marked* anything done").
      { kind: 'toolNotCalled', tool: 'update' },
    ],
    replyRubric:
      'Reports that no matching dentist task was found rather than claiming one was marked done. Markdown is fine.',
  },

  // ----------------------------------------------------------------------------
  // pagination — a truncated list result the agent must page through
  // ----------------------------------------------------------------------------
  {
    id: 'm8-page-01',
    capability: 'pagination',
    sms: 'What tasks do I have?',
    mocks: { list: paginated(TASK_ROWS, 5) },
    expect: [
      { kind: 'toolCalled', tool: 'list' },
      { kind: 'pagedAllResults', tool: 'list' },
    ],
    replyRubric:
      'Summarizes the full task list, paging through every result page rather than reporting only the first page. Markdown is fine.',
  },

  // ----------------------------------------------------------------------------
  // error-recovery — the mutating tool errors on first call
  // ----------------------------------------------------------------------------
  {
    id: 'm8-err-01',
    capability: 'error-recovery',
    sms: 'Add "buy milk" to my tasks.',
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
      'Either retries the create after the server error or honestly reports the failure — never claims success off the errored call. Markdown is fine.',
  },
  {
    // Persistent failure: the create errors on EVERY attempt. The only honest
    // outcome is to report the failure — never a fabricated success. Distinct
    // from m8-err-01 (where a retry succeeds) now that noSuccessAfterError credits
    // a successful last call.
    id: 'm8-err-persistent',
    capability: 'error-recovery',
    sms: 'Add "buy milk" to my tasks.',
    mocks: {
      create: () => ({ __error: { code: 500, message: 'server error' } }),
    },
    expect: [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'noSuccessAfterError', tool: 'create' },
    ],
    replyRubric:
      'Honestly reports that the task could not be added because the server kept erroring — never claims it was added. Markdown is fine.',
  },
  {
    // Zero-result-for-an-action: the user asks to mutate a named entity that does
    // not exist. Correct discipline: look it up, find nothing, report it — do not
    // fabricate an id or claim success. Distinct from m8-fab-01's "mark done" by
    // exercising a reschedule (update) on a missing calendar event.
    id: 'm8-zero-result',
    capability: 'fabrication-bait',
    sms: 'Reschedule the budget review to next Tuesday at 2pm.',
    mocks: emptySearchMock,
    expect: [
      { kind: 'toolCalledAnyOf', tools: ['search', 'list'] },
      { kind: 'toolNotCalled', tool: 'update' },
    ],
    replyRubric:
      'Reports that no "budget review" event was found rather than rescheduling a fabricated one. Markdown is fine.',
  },

  // ----------------------------------------------------------------------------
  // active-item-disambiguation — a <screen-context> supplies an <active-item>
  // WITH its real id, and the user points at it deictically ("this", "that",
  // "it"). A correct agent acts on that id directly and MUST NOT call search or
  // list first — the id is already in hand.
  // ----------------------------------------------------------------------------
  {
    id: 'm8-active-01',
    capability: 'active-item-disambiguation',
    sms: 'Delete this.',
    screenContext: screenContextWithActiveItem({
      route: 'tasks',
      activeItemType: 'task',
      activeItemId: 'task-passport-01',
      activeItemName: 'Renew passport',
      containerType: 'task_list',
      containerId: MURMUR8_ID,
      containerName: 'Murmur8',
    }),
    expect: [
      { kind: 'toolCalled', tool: 'delete' },
      { kind: 'argEquals', tool: 'delete', path: 'type', value: 'task' },
      { kind: 'argEquals', tool: 'delete', path: 'taskId', value: 'task-passport-01' },
      { kind: 'toolNotCalled', tool: 'search' },
      { kind: 'toolNotCalled', tool: 'list' },
    ],
    replyRubric:
      'Confirms the "Renew passport" task was deleted, acting on the active item without looking it up first. Markdown is fine.',
  },
  {
    id: 'm8-active-02',
    capability: 'active-item-disambiguation',
    sms: 'Mark that as done.',
    screenContext: screenContextWithActiveItem({
      route: 'tasks',
      activeItemType: 'task',
      activeItemId: 'task-water-bill-02',
      activeItemName: 'Pay water bill',
      containerType: 'task_list',
      containerId: PERSONAL_ID,
      containerName: 'Personal',
    }),
    expect: [
      { kind: 'toolCalled', tool: 'update' },
      { kind: 'argEquals', tool: 'update', path: 'taskId', value: 'task-water-bill-02' },
      { kind: 'argEquals', tool: 'update', path: 'status', value: 'Completed' },
      { kind: 'toolNotCalled', tool: 'search' },
      { kind: 'toolNotCalled', tool: 'list' },
    ],
    replyRubric:
      'Confirms the "Pay water bill" task was marked done, acting on the active item directly. Markdown is fine.',
  },
  {
    id: 'm8-active-03',
    capability: 'active-item-disambiguation',
    sms: 'Move it to 4pm.',
    screenContext: screenContextWithActiveItem({
      route: 'calendar',
      activeItemType: 'calendar_event',
      activeItemId: 'evt-dentist-03',
      activeItemName: 'Dentist',
      containerType: 'calendar',
      containerId: PERSONAL_ID,
      containerName: 'Personal',
    }),
    expect: [
      { kind: 'toolCalled', tool: 'update' },
      { kind: 'argEquals', tool: 'update', path: 'eventId', value: 'evt-dentist-03' },
      { kind: 'argMatches', tool: 'update', path: 'startTime', regex: '^2026-06-26T16:00' },
      { kind: 'toolNotCalled', tool: 'search' },
      { kind: 'toolNotCalled', tool: 'list' },
    ],
    replyRubric:
      'Confirms the Dentist event was moved to 4pm today, acting on the open event directly. Markdown is fine.',
  },
  {
    id: 'm8-active-04',
    capability: 'active-item-disambiguation',
    sms: 'Cancel this one.',
    screenContext: screenContextWithActiveItem({
      route: 'calendar',
      activeItemType: 'calendar_event',
      activeItemId: 'evt-standup-04',
      activeItemName: 'Team standup',
      containerType: 'calendar',
      containerId: CONNECTWISE_ID,
      containerName: 'Connectwise',
    }),
    expect: [
      { kind: 'toolCalled', tool: 'delete' },
      { kind: 'argEquals', tool: 'delete', path: 'type', value: 'calendar_event' },
      { kind: 'argEquals', tool: 'delete', path: 'eventId', value: 'evt-standup-04' },
      { kind: 'toolNotCalled', tool: 'search' },
      { kind: 'toolNotCalled', tool: 'list' },
    ],
    replyRubric:
      'Confirms the Team standup event was cancelled, acting on the open event directly. Markdown is fine.',
  },
  {
    id: 'm8-active-05',
    capability: 'active-item-disambiguation',
    sms: 'Bump the priority on this to high.',
    screenContext: screenContextWithActiveItem({
      route: 'tasks',
      activeItemType: 'task',
      activeItemId: 'task-quarterly-05',
      activeItemName: 'Finish the quarterly review',
      containerType: 'task_list',
      containerId: MURMUR8_ID,
      containerName: 'Murmur8',
    }),
    expect: [
      { kind: 'toolCalled', tool: 'update' },
      { kind: 'argEquals', tool: 'update', path: 'taskId', value: 'task-quarterly-05' },
      { kind: 'argEquals', tool: 'update', path: 'priority', value: 1 },
      { kind: 'toolNotCalled', tool: 'search' },
      { kind: 'toolNotCalled', tool: 'list' },
    ],
    replyRubric:
      'Confirms the quarterly review task was set to high priority, acting on the open task directly. Markdown is fine.',
  },
  {
    id: 'm8-active-06',
    capability: 'active-item-disambiguation',
    sms: 'Rename the one I just opened to "Renew UK passport".',
    screenContext: screenContextWithActiveItem({
      route: 'tasks',
      activeItemType: 'task',
      activeItemId: 'task-passport-06',
      activeItemName: 'Renew passport',
      containerType: 'task_list',
      containerId: MURMUR8_ID,
      containerName: 'Murmur8',
    }),
    expect: [
      { kind: 'toolCalled', tool: 'update' },
      { kind: 'argEquals', tool: 'update', path: 'taskId', value: 'task-passport-06' },
      { kind: 'argEquals', tool: 'update', path: 'title', value: 'Renew UK passport' },
      { kind: 'toolNotCalled', tool: 'search' },
      { kind: 'toolNotCalled', tool: 'list' },
    ],
    replyRubric:
      'Confirms the open task was renamed to "Renew UK passport", acting on the active item directly. Markdown is fine.',
  },

  // ----------------------------------------------------------------------------
  // active-item-guardrail — an <active-item> is focused, but the user NAMES a
  // DIFFERENT entity. A correct agent must resolve the named thing by listing or
  // searching (per the ENTITY LOOKUP RULES), NOT blindly reuse the active item.
  // ----------------------------------------------------------------------------
  {
    id: 'm8-active-guard-01',
    capability: 'active-item-guardrail',
    sms: 'Mark the grocery run task done.',
    screenContext: screenContextWithActiveItem({
      route: 'tasks',
      activeItemType: 'task',
      activeItemId: 'task-passport-g1',
      activeItemName: 'Renew passport',
      containerType: 'task_list',
      containerId: MURMUR8_ID,
      containerName: 'Murmur8',
    }),
    mocks: namedTaskMock({
      id: 'task-grocery-run-g1',
      title: 'Grocery run',
      taskListId: GROCERIES_ID,
    }),
    expect: [
      { kind: 'toolCalledAnyOf', tools: ['search', 'list'] },
      { kind: 'argEquals', tool: 'update', path: 'taskId', value: 'task-grocery-run-g1' },
    ],
    replyRubric:
      'Looks up the named "Grocery run" task rather than acting on the focused "Renew passport" item, then marks the correct one done. Markdown is fine.',
  },
  {
    id: 'm8-active-guard-02',
    capability: 'active-item-guardrail',
    sms: 'Delete my dentist task.',
    screenContext: screenContextWithActiveItem({
      route: 'tasks',
      activeItemType: 'task',
      activeItemId: 'task-quarterly-g2',
      activeItemName: 'Finish the quarterly review',
      containerType: 'task_list',
      containerId: MURMUR8_ID,
      containerName: 'Murmur8',
    }),
    mocks: namedTaskMock({
      id: 'task-dentist-g2',
      title: 'Book dentist appointment',
      taskListId: PERSONAL_ID,
    }),
    expect: [
      { kind: 'toolCalledAnyOf', tools: ['search', 'list'] },
      { kind: 'argEquals', tool: 'delete', path: 'taskId', value: 'task-dentist-g2' },
    ],
    replyRubric:
      'Looks up the named "dentist" task rather than acting on the focused "quarterly review" item, then deletes the correct one. Markdown is fine.',
  },
];
