// A realistic account-wide task board for the paging cases ("what tasks do I have?"). Its size
// mirrors the owner's live murmur8 account (murmur8-postgres, 2026-09-28: 33 NeedsAction and 7
// InProcess tasks across boards, most with no due date, priority 0 or 2): 40 active tasks, so the
// production default page of 20 needs one `nextCursor` follow, plus done tasks that the default
// active-only filter hides. Titles are invented; ids are GUID-shaped like production ids.

import { createHash } from 'node:crypto';
import type { MockTask, TaskStatus } from './murmur8-results.js';

const GROCERIES_ID = '7101b4ff-d49d-4117-a055-d3a67e9971d9';
const MURMUR8_ID = '87697694-3927-462a-b15b-21e2008c0597';
const SHOPPING_ID = '8fb60e48-04f4-4f14-bbb3-ca55eed87eb6';

interface BoardEntry {
  title: string;
  taskListId: string;
  status?: TaskStatus;
  priority?: number;
  dueDate?: string;
}

// Newest first: the array order is the updatedAt order.
const ENTRIES: BoardEntry[] = [
  { title: 'Fix calendar sync retry backoff', taskListId: MURMUR8_ID, status: 'InProcess', priority: 2 },
  { title: 'Eggs', taskListId: GROCERIES_ID },
  { title: 'Birthday card for Grandma', taskListId: SHOPPING_ID, status: 'InProcess', priority: 2, dueDate: '2026-07-02T00:00:00Z' },
  { title: 'Review the photo backfill PR', taskListId: MURMUR8_ID, status: 'InProcess' },
  { title: 'Milk', taskListId: GROCERIES_ID, status: 'Completed' },
  { title: 'Write release notes for 0.9', taskListId: MURMUR8_ID, priority: 2, dueDate: '2026-06-30T00:00:00Z' },
  { title: 'Coffee beans', taskListId: GROCERIES_ID },
  { title: 'Sunscreen', taskListId: SHOPPING_ID },
  { title: 'Rotate the MinIO access keys', taskListId: MURMUR8_ID, priority: 2 },
  { title: 'Fix the reminder snooze bug', taskListId: MURMUR8_ID, status: 'Completed', priority: 2 },
  { title: 'Greek yogurt', taskListId: GROCERIES_ID },
  { title: 'Add pagination to the reminders view', taskListId: MURMUR8_ID, status: 'InProcess' },
  { title: 'Bike tire tube', taskListId: SHOPPING_ID },
  { title: 'Spinach', taskListId: GROCERIES_ID },
  { title: 'Profile the search query on large boards', taskListId: MURMUR8_ID, priority: 2 },
  { title: 'Order a new router', taskListId: SHOPPING_ID, status: 'Completed' },
  { title: 'Update the iOS build certificate', taskListId: MURMUR8_ID, priority: 2, dueDate: '2026-07-10T00:00:00Z' },
  { title: 'Chicken thighs', taskListId: GROCERIES_ID },
  { title: 'Printer ink', taskListId: SHOPPING_ID, priority: 2 },
  { title: 'Draft the Q3 roadmap', taskListId: MURMUR8_ID },
  { title: 'Tortillas', taskListId: GROCERIES_ID },
  { title: 'Triage the IMAP sync errors', taskListId: MURMUR8_ID, status: 'InProcess', priority: 2 },
  { title: 'Butter', taskListId: GROCERIES_ID, status: 'Completed' },
  { title: 'Dog food', taskListId: SHOPPING_ID },
  { title: 'Clean up stale feature flags', taskListId: MURMUR8_ID },
  { title: 'Olive oil', taskListId: GROCERIES_ID },
  { title: 'Light bulbs for the porch', taskListId: SHOPPING_ID, priority: 2 },
  { title: 'Document the job queue retry rules', taskListId: MURMUR8_ID },
  { title: 'Set up the GitHub runner', taskListId: MURMUR8_ID, status: 'Completed' },
  { title: 'Bananas', taskListId: GROCERIES_ID },
  { title: 'Move nightly backups to the new disk', taskListId: MURMUR8_ID, priority: 2 },
  { title: 'Replacement furnace filter', taskListId: SHOPPING_ID, priority: 2 },
  { title: 'Shredded cheese', taskListId: GROCERIES_ID },
  { title: 'Upgrade Postgres to 16.4', taskListId: MURMUR8_ID, status: 'InProcess', priority: 2 },
  { title: 'Return the broken blender', taskListId: SHOPPING_ID, status: 'Cancelled' },
  { title: 'Picture frames', taskListId: SHOPPING_ID },
  { title: 'Lunch meat', taskListId: GROCERIES_ID },
  { title: 'Reply to the calendar feed bug report', taskListId: MURMUR8_ID },
  { title: 'Paper towels', taskListId: GROCERIES_ID, status: 'Completed' },
  { title: 'HDMI cable for the office', taskListId: SHOPPING_ID },
  { title: 'Rename the share link settings page', taskListId: MURMUR8_ID, status: 'InProcess', priority: 2 },
  { title: 'Sparkling water', taskListId: GROCERIES_ID },
  { title: 'Ship the lean list payloads', taskListId: MURMUR8_ID, status: 'Completed' },
  { title: 'Rain gauge', taskListId: SHOPPING_ID },
  { title: 'Check disk usage alerts', taskListId: MURMUR8_ID, priority: 2 },
  { title: 'Frozen blueberries', taskListId: GROCERIES_ID },
  { title: 'Extension cord', taskListId: SHOPPING_ID },
  { title: 'New running shoes', taskListId: SHOPPING_ID },
];

/** A stable GUID-shaped id derived from the title (production ids are GUIDs). */
function fixtureGuid(seed: string): string {
  const hex = createHash('sha1').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * UpdatedAt for the entry at `index` (0 = newest): about every 19 hours back from the pinned
 * morning, with microseconds as Postgres stores them. System.Text.Json trims trailing zeros from
 * the fraction, so the last digit is kept non-zero and the text is exactly what the cursor carries.
 */
function updatedAtFor(index: number): string {
  const newest = Date.UTC(2026, 5, 26, 16, 41, 7);
  const instant = new Date(newest - index * ((19 * 60 + 23) * 60 + 11) * 1000);
  let microseconds = (318264 + index * 7919) % 1000000;
  if (microseconds % 10 === 0) microseconds += 1;
  const seconds = instant.toISOString().slice(0, 19);
  return `${seconds}.${String(microseconds).padStart(6, '0')}Z`;
}

/** The whole board, newest first: 40 active tasks (33 NeedsAction, 7 InProcess) and 8 done. */
export const TASK_BOARD: readonly MockTask[] = ENTRIES.map((entry, index) => {
  const task: MockTask = {
    id: fixtureGuid(`task-board:${entry.title}`),
    title: entry.title,
    taskListId: entry.taskListId,
    status: entry.status ?? 'NeedsAction',
    priority: entry.priority ?? 0,
    updatedAt: updatedAtFor(index),
  };
  if (entry.dueDate !== undefined) task.dueDate = entry.dueDate;
  return task;
});
