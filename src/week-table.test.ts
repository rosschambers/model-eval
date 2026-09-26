import { describe, it, expect } from 'vitest';
import { buildWeekTable } from './week-table.js';

describe('buildWeekTable', () => {
  it('renders the golden literal for the pinned rollover clock (America/Detroit)', () => {
    expect(buildWeekTable('2026-09-26T17:25:00Z', 'America/Detroit')).toBe(
      'Next 7 days: Saturday 2026-09-26 (today), Sunday 2026-09-27 (tomorrow), ' +
        'Monday 2026-09-28, Tuesday 2026-09-29, Wednesday 2026-09-30, Thursday 2026-10-01, ' +
        'Friday 2026-10-02.',
    );
  });

  it('rolls over at local midnight, not UTC midnight: 10:30 PM Saturday local is still Saturday', () => {
    const table = buildWeekTable('2026-09-27T02:30:00Z', 'America/Detroit');
    expect(table.startsWith('Next 7 days: Saturday 2026-09-26 (today), Sunday 2026-09-27 (tomorrow),')).toBe(
      true,
    );
  });

  it('carries the week table across a year boundary', () => {
    expect(buildWeekTable('2026-12-31T18:00:00Z', 'America/Detroit')).toBe(
      'Next 7 days: Thursday 2026-12-31 (today), Friday 2027-01-01 (tomorrow), ' +
        'Saturday 2027-01-02, Sunday 2027-01-03, Monday 2027-01-04, Tuesday 2027-01-05, ' +
        'Wednesday 2027-01-06.',
    );
  });
});
