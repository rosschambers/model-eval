import { describe, it, expect } from 'vitest';
import {
  runTool,
  defaultMocks,
  paginated,
  errorOnce,
  type MockMap,
} from './mock-engine.js';

describe('runTool', () => {
  it('handles Parse_Date_Time via code-tools and JSON-stringifies', () => {
    const result = runTool(
      'Parse_Date_Time',
      { localDateTime: '2026-06-28T15:00:00' },
      {},
    );
    expect(result).toContain('"utc":"2026-06-28T19:00:00Z"');
  });

  it('handles murmur8 parse_date_time (snake_case) via the same code-tool, DST-correct', () => {
    // 2026-06-28 is EDT (UTC-4) in America/Detroit → 15:00 local = 19:00Z.
    const result = runTool(
      'parse_date_time',
      { localDateTime: '2026-06-28T15:00:00' },
      {},
    );
    expect(result).toContain('"utc":"2026-06-28T19:00:00Z"');
    expect(result).toContain('"localNaive":"2026-06-28T15:00:00"');
  });

  it('handles Convert_Time via code-tools and returns the string', () => {
    const result = runTool(
      'Convert_Time',
      { utcIso: '2026-06-28T19:00:00Z' },
      {},
    );
    expect(result).toContain('3:00');
  });

  it('lists calendars from defaultMocks when case mocks are empty', () => {
    const result = runTool('list', { type: 'calendars' }, {});
    expect(result).toContain('53c6b1e2-e1fa-4cae-94ed-32a1c016e2d7');
  });

  it('lists task lists from defaultMocks', () => {
    const result = runTool('list', { type: 'task_lists' }, {});
    expect(result).toContain('groceries');
  });

  it('echoes create args back with a fake id', () => {
    const result = runTool(
      'create',
      {
        type: 'calendar_event',
        startTime: '2026-06-28T15:00:00',
        timeZone: 'America/Detroit',
      },
      {},
    );
    expect(result).toContain('mock-calendar_event-0001');
    expect(result).toContain('2026-06-28T15:00:00');
  });

  it('lets a per-case mock override defaultMocks at the tool-function level', () => {
    const mocks: MockMap = {
      list: () => ({ results: [{ id: 'x', title: 'water bill' }] }),
    };
    const result = runTool('list', { type: 'tasks' }, mocks);
    expect(result).toContain('water bill');
  });

  it('returns a no-mock error for unknown tools', () => {
    const result = runTool('nonexistent_tool', {}, {});
    expect(result).toContain('no mock for tool nonexistent_tool');
  });
});

describe('defaultMocks', () => {
  it('is exported as a MockMap', () => {
    expect(typeof defaultMocks).toBe('object');
  });

  it('lists calendars with realistic fields and preserved ids', () => {
    const { results } = defaultMocks.list({ type: 'calendars' }) as {
      results: Array<Record<string, unknown>>;
    };
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName.Personal.id).toBe('2e9ee3a1-4864-467c-9147-2c2092915be1');
    expect(byName.Household.id).toBe('53c6b1e2-e1fa-4cae-94ed-32a1c016e2d7');
    expect(byName.Connectwise.id).toBe('9fa91c0a-1111-2222-3333-444455556666');
    for (const row of results) {
      expect(row).toHaveProperty('color');
      expect(row).toHaveProperty('isDefault');
    }
  });
});

describe('paginated', () => {
  it('pages until the cursor is exhausted', () => {
    const fn = paginated([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 2);
    const p1 = JSON.parse(fn({}) as any);
    expect(p1.results).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = JSON.parse(fn({ cursor: p1.nextCursor }) as any);
    expect(p2.results).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
  });
});

describe('errorOnce', () => {
  it('errorOnce errors first then returns', () => {
    const fn = errorOnce({ code: 500, message: 'boom' }, { ok: true });
    expect(runTool('list', {}, { list: fn })).toContain('boom');
    expect(runTool('list', {}, { list: fn })).toContain('ok');
  });
});
