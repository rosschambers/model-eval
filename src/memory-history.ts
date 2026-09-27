// Authoring helpers for memory-follow-up histories. An earlier turn is written the way production
// stored it: the user turn, one model step per tool call (the call plus the raw JSON the tool
// returned), then the final reply. The result shapes copy real murmur8 tool output:
// - `list` rows: the camelCase `{results, nextCursor}` page (fixtures/responses-fixture.json).
// - `create` echoes: the PascalCase entity murmur8 returns (hugo_chat_history rows 972 for a
//   reminder, 1000 for a calendar event, 617 for a task; murmur8 ConversationMessages agrees).
// Each profile's replayHistory (./history.ts) then renders these into what its memory replays.

import responses from '../fixtures/responses-fixture.json' with { type: 'json' };
import type { HistoryMessage } from './case.js';

const USER_TIMEZONE = 'America/Detroit';

/** One model step of an earlier turn: a single tool call and the JSON its tool returned. */
export interface HistoryStep {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

/** An earlier tool-using turn: user message, one assistant call + tool result per step, final reply. */
export function toolTurn(turn: { user: string; steps: HistoryStep[]; reply: string }): HistoryMessage[] {
  const messages: HistoryMessage[] = [{ role: 'user', content: turn.user }];
  for (const step of turn.steps) {
    messages.push({ role: 'assistant', content: null, toolCalls: [{ id: step.id, name: step.name, arguments: step.arguments }] });
    messages.push({ role: 'tool', toolCallId: step.id, name: step.name, content: JSON.stringify(step.result) });
  }
  messages.push({ role: 'assistant', content: turn.reply });
  return messages;
}

/** `list {type:'calendars'}` — the fixture's calendars. */
export function calendarsListResult(): unknown {
  return { results: responses.calendars, nextCursor: null };
}

/** `list {type:'task_lists'}` — the fixture's task lists. */
export function taskListsListResult(): unknown {
  return { results: responses.taskLists, nextCursor: null };
}

/** The `create {type:'calendar_event'}` echo. Start and end are the UTC instants murmur8 stores. */
export function createdEventEcho(event: { id: string; title: string; calendarId: string; startUtc: string; endUtc: string }): unknown {
  return {
    Id: event.id,
    Uid: `${event.id}@murmur8`,
    Title: event.title,
    Description: null,
    Location: null,
    StartTime: event.startUtc,
    EndTime: event.endUtc,
    IsAllDay: false,
    TimeZone: USER_TIMEZONE,
    RecurrenceRule: null,
    CalendarIds: [event.calendarId],
    Ref: { entityType: 'CalendarEvent', entityId: event.id },
  };
}

/** The `create {type:'task'}` echo. */
export function createdTaskEcho(task: { id: string; title: string; taskListId: string }): unknown {
  return {
    Id: task.id,
    Title: task.title,
    Description: null,
    Status: 0,
    Priority: 0,
    DueDate: null,
    Tags: [],
    ParentTaskId: null,
    TaskListId: task.taskListId,
    Ref: { entityType: 'TaskItem', entityId: task.id, parentEntityId: task.taskListId },
  };
}

/** The `create {type:'reminder'}` echo. */
export function createdReminderEcho(reminder: { id: string; title: string; remindAt: string }): unknown {
  return { Id: reminder.id, Title: reminder.title, Note: null, RemindAt: reminder.remindAt, Status: 'Pending', LinkedTaskId: null };
}
