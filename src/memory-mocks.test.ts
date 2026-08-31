import { describe, it, expect } from 'vitest';
import { runTool } from './mock-engine.js';
import { CASES } from './cases.js';

function mocksFor(id: string) {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error('missing case ' + id);
  return c.mocks ?? {};
}

describe('memory-followup seeded mocks', () => {
  it('mem-01 surfaces the Dentist event on the Personal calendar', () => {
    const m = mocksFor('mem-01');
    const out = JSON.parse(
      runTool('list', { type: 'calendar_events', calendarId: '2e9ee3a1-4864-467c-9147-2c2092915be1' }, m),
    );
    expect(out.results.map((e: any) => e.id)).toContain('mock-evt-dentist');
  });

  it('mem-03 surfaces the call-the-bank reminder', () => {
    const m = mocksFor('mem-03');
    const out = JSON.parse(runTool('list', { type: 'reminders' }, m));
    expect(out.results.map((r: any) => r.id)).toContain('mock-rem-bank');
  });

  it('mem-04 surfaces the standup on the Connectwise calendar', () => {
    const m = mocksFor('mem-04');
    const out = JSON.parse(
      runTool('list', { type: 'calendar_events', calendarId: '9fa91c0a-1111-2222-3333-444455556666' }, m),
    );
    expect(out.results.map((e: any) => e.id)).toContain('mock-evt-standup');
  });
});
