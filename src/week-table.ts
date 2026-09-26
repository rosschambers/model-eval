/**
 * The "Next 7 days" lookup line every production clock carries (murmur8 `<user-context>`, Hugo REQUEST
 * CONTEXT): today and the next six LOCAL days with weekday names and ISO dates, so a bare weekday or
 * "tomorrow" is read off the context instead of computed. A 9B model's implicit weekday arithmetic
 * resolved bare weekdays a week late or into the past depending on the date; with the table it reads
 * them.
 *
 * This file MUST stay byte-identical to crucible `src/week-table.ts`, murmur8
 * `ChatMessageBuilder.BuildWeekTable`, and the n8n Hugo workflow's `weekTable` field. Copy changes to
 * all four places together.
 */

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** The local calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function localDateOf(instantIso: string, timeZone: string): string {
  return new Date(instantIso).toLocaleDateString('en-CA', { timeZone });
}

/** A calendar date plus a number of days (calendar arithmetic, no timezone involved). */
export function addDays(date: string, days: number): string {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday for a calendar date. */
export function weekdayIndexOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** "Next 7 days: Saturday 2026-09-26 (today), Sunday 2026-09-27 (tomorrow), Monday 2026-09-28, …." */
export function buildWeekTable(clockUtc: string, timeZone: string): string {
  const today = localDateOf(clockUtc, timeZone);
  const days: string[] = [];
  for (let offset = 0; offset < 7; offset++) {
    const date = addDays(today, offset);
    let suffix = '';
    if (offset === 0) suffix = ' (today)';
    else if (offset === 1) suffix = ' (tomorrow)';
    days.push(`${WEEKDAYS[weekdayIndexOf(date)]} ${date}${suffix}`);
  }
  return `Next 7 days: ${days.join(', ')}.`;
}
