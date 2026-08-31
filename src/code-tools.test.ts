import { describe, it, expect } from 'vitest';
import { parseDateTime, convertTime } from './code-tools.js';

describe('parseDateTime', () => {
  it('handles the EDT summer case (UTC-4)', () => {
    const result = parseDateTime({
      localDateTime: '2026-06-28T15:00:00',
      timeZone: 'America/Detroit',
    });
    expect(typeof result).toBe('object');
    if (typeof result === 'string') throw new Error(result);
    expect(result.utc).toBe('2026-06-28T19:00:00Z');
    expect(result.localNaive).toBe('2026-06-28T15:00:00');
    expect(result.timeZone).toBe('America/Detroit');
  });

  it('handles the EST winter case (UTC-5)', () => {
    const result = parseDateTime({
      localDateTime: '2026-01-15T15:00:00',
      timeZone: 'America/Detroit',
    });
    if (typeof result === 'string') throw new Error(result);
    expect(result.utc).toBe('2026-01-15T20:00:00Z');
  });

  it('strips a stray trailing Z and treats it as wall-clock, not UTC', () => {
    const result = parseDateTime({
      localDateTime: '2026-06-28T15:00:00Z',
      timeZone: 'America/Detroit',
    });
    if (typeof result === 'string') throw new Error(result);
    expect(result.utc).toBe('2026-06-28T19:00:00Z');
  });

  it('falls back to defaultTz when input.timeZone is absent', () => {
    const result = parseDateTime(
      { localDateTime: '2026-06-28T15:00:00' },
      'America/Detroit',
    );
    if (typeof result === 'string') throw new Error(result);
    expect(result.utc).toBe('2026-06-28T19:00:00Z');
  });

  it('returns an error string for invalid input', () => {
    const result = parseDateTime({
      localDateTime: 'not a date',
      timeZone: 'America/Detroit',
    });
    expect(typeof result).toBe('string');
    expect(result as string).toMatch(/^Invalid localDateTime/);
  });
});

describe('convertTime', () => {
  it('converts a UTC timestamp to local wall-clock time', () => {
    const result = convertTime(
      { utcIso: '2026-06-28T19:00:00Z' },
      'America/Detroit',
    );
    expect(result).toContain('3:00');
    expect(result).toContain('PM');
  });

  it('returns an error string for a bad timestamp', () => {
    const result = convertTime({ utcIso: 'garbage' }, 'America/Detroit');
    expect(result).toMatch(/^Invalid timestamp/);
  });
});
