// Faithful TypeScript ports of two n8n `toolCode` date/time helpers from the
// live Hugo agent. Behavior matches the original jsCode bodies exactly; the
// only difference is that the user's timezone is passed in as an argument
// instead of read from an n8n node.

export interface ParseDateTimeInput {
  localDateTime: string;
  timeZone?: string;
}

export interface ParseDateTimeResult {
  localNaive: string;
  utc: string;
  timeZone: string;
}

/**
 * Convert a LOCAL wall-clock date-time into both its naive local form and the
 * exact UTC instant, using a DST-correct two-pass offset calculation.
 *
 * Returns the result object on success, or an error string on invalid input
 * (never throws).
 */
export function parseDateTime(
  input: ParseDateTimeInput,
  defaultTz?: string,
): ParseDateTimeResult | string {
  const tz = input.timeZone || defaultTz || 'America/Detroit';
  const s = String(input.localDateTime || '')
    .trim()
    .replace(/[zZ]$/, '')
    .replace(/[+-]\d{2}:?\d{2}$/, '');
  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!m) {
    return (
      'Invalid localDateTime (expected e.g. 2026-04-22T15:00:00): ' +
      input.localDateTime
    );
  }
  const Y = +m[1];
  const Mo = +m[2];
  const D = +m[3];
  const H = +m[4];
  const Mi = +m[5];
  const S = +(m[6] || 0);

  function off(utcMs: number): number {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(utcMs))
      .reduce<Record<string, string>>((a, x) => {
        a[x.type] = x.value;
        return a;
      }, {});
    let hh = +p.hour;
    if (hh === 24) hh = 0;
    return (
      Date.UTC(+p.year, +p.month - 1, +p.day, hh, +p.minute, +p.second) - utcMs
    );
  }

  const guess = Date.UTC(Y, Mo - 1, D, H, Mi, S);
  let utcMs = guess - off(guess);
  utcMs = guess - off(utcMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const localNaive = `${Y}-${pad(Mo)}-${pad(D)}T${pad(H)}:${pad(Mi)}:${pad(S)}`;
  const utc = new Date(utcMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { localNaive, utc, timeZone: tz };
}

export interface ConvertTimeInput {
  utcIso: string;
}

/**
 * Convert a UTC ISO 8601 timestamp to a human-readable local time string.
 *
 * Returns the formatted string on success, or "Invalid timestamp: ..." on a
 * bad input (never throws).
 */
export function convertTime(input: ConvertTimeInput, tz: string): string {
  const utcIso = input.utcIso;
  const d = new Date(utcIso);
  if (isNaN(d.getTime())) return 'Invalid timestamp: ' + utcIso;
  return d.toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
