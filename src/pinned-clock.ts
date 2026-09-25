// The single pinned benchmark clock shared by every profile. Cases assert exact
// instants derived from it (for example "tomorrow at 9am" = 2026-06-27T09:00), so
// every prompt builder MUST read the clock from here — a second copy that drifts
// would silently make date cases unwinnable for every model.

/** Pinned "now": Friday June 26 2026, 2:00 PM EDT. */
export const NOW_UTC_ISO = '2026-06-26T18:00:00Z';

/** The benchmark user's timezone (EDT = UTC-4 in summer). */
export const USER_TIMEZONE = 'America/Detroit';

/**
 * The pinned instant as the user's local wall-clock time, in the same
 * `toLocaleString('en-US', …)` shape n8n produces for `nowLocal`:
 * "Friday, June 26, 2026 at 2:00 PM".
 */
export function pinnedLocalTime(): string {
  return new Date(NOW_UTC_ISO).toLocaleString('en-US', {
    timeZone: USER_TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
