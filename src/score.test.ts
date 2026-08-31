import { describe, it, expect } from 'vitest';
import { scoreCase } from './score.js';
import type { Transcript, Assertion } from './case.js';

function makeTranscript(toolCalls: Transcript['toolCalls']): Transcript {
  return { toolCalls, finalText: '', iterations: 1, latencyMs: 0 };
}

describe('scoreCase', () => {
  const calendarEvent = makeTranscript([
    {
      name: 'create',
      args: {
        type: 'calendar_event',
        startTime: '2026-06-28T15:00:00',
        timeZone: 'America/Detroit',
        calendarId: '53c6b1e2-e1fa-4cae-94ed-32a1c016e2d7',
      },
    },
  ]);

  it('case 1: local-no-Z startTime passes argIsLocalNoZ', () => {
    const assertions: Assertion[] = [
      { kind: 'argIsLocalNoZ', tool: 'create', path: 'startTime' },
    ];
    const [result] = scoreCase(calendarEvent, assertions);
    expect(result.passed).toBe(true);
  });

  it('case 1: local-no-Z startTime fails argIsUtc', () => {
    const assertions: Assertion[] = [
      { kind: 'argIsUtc', tool: 'create', path: 'startTime' },
    ];
    const [result] = scoreCase(calendarEvent, assertions);
    expect(result.passed).toBe(false);
  });

  it('case 1: uuid calendarId passes noNameAsId', () => {
    const assertions: Assertion[] = [
      {
        kind: 'noNameAsId',
        tool: 'create',
        path: 'calendarId',
        names: ['Household', 'Personal', 'Connectwise'],
      },
    ];
    const [result] = scoreCase(calendarEvent, assertions);
    expect(result.passed).toBe(true);
  });

  it('case 1: timeZone argEquals passes', () => {
    const assertions: Assertion[] = [
      {
        kind: 'argEquals',
        tool: 'create',
        path: 'timeZone',
        value: 'America/Detroit',
      },
    ];
    const [result] = scoreCase(calendarEvent, assertions);
    expect(result.passed).toBe(true);
  });

  it('case 2: display-name calendarId fails noNameAsId', () => {
    const transcript = makeTranscript([
      { name: 'create', args: { type: 'calendar_event', calendarId: 'Household' } },
    ]);
    const assertions: Assertion[] = [
      { kind: 'noNameAsId', tool: 'create', path: 'calendarId', names: ['Household'] },
    ];
    const [result] = scoreCase(transcript, assertions);
    expect(result.passed).toBe(false);
  });

  it('case 3: UTC remindAt passes argIsUtc', () => {
    const transcript = makeTranscript([
      { name: 'create', args: { type: 'reminder', remindAt: '2026-06-28T22:00:00Z' } },
    ]);
    const assertions: Assertion[] = [
      { kind: 'argIsUtc', tool: 'create', path: 'remindAt' },
    ];
    const [result] = scoreCase(transcript, assertions);
    expect(result.passed).toBe(true);
  });

  it('case 4: toolCalled / toolNotCalled semantics', () => {
    const transcript = makeTranscript([
      { name: 'list', args: { type: 'calendars' } },
    ]);
    const results = scoreCase(transcript, [
      { kind: 'toolCalled', tool: 'list' },
      { kind: 'toolNotCalled', tool: 'list' },
      { kind: 'toolNotCalled', tool: 'create' },
    ]);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
    expect(results[2].passed).toBe(true);
  });

  it('case 5: callOrder passes when before precedes after', () => {
    const transcript = makeTranscript([
      { name: 'list', args: {} },
      { name: 'create', args: {} },
    ]);
    const [result] = scoreCase(transcript, [
      { kind: 'callOrder', before: 'list', after: 'create' },
    ]);
    expect(result.passed).toBe(true);
  });

  it('case 5: callOrder fails when before follows after', () => {
    const transcript = makeTranscript([
      { name: 'create', args: {} },
      { name: 'list', args: {} },
    ]);
    const [result] = scoreCase(transcript, [
      { kind: 'callOrder', before: 'list', after: 'create' },
    ]);
    expect(result.passed).toBe(false);
  });

  it('case 6: assertion on a missing tool fails with a detail mentioning the missing call', () => {
    const transcript = makeTranscript([
      { name: 'create', args: { type: 'calendar_event' } },
    ]);
    const [result] = scoreCase(transcript, [
      { kind: 'argEquals', tool: 'update', path: 'eventId', value: 'x' },
    ]);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/update/);
  });

  it('argMatches coerces and matches a regex', () => {
    const [result] = scoreCase(calendarEvent, [
      { kind: 'argMatches', tool: 'create', path: 'startTime', regex: '^2026-06-28' },
    ]);
    expect(result.passed).toBe(true);
  });

  it('noNameAsId passes when the value is absent', () => {
    const [result] = scoreCase(calendarEvent, [
      { kind: 'noNameAsId', tool: 'create', path: 'missingField', names: ['Household'] },
    ]);
    expect(result.passed).toBe(true);
    expect(result.detail).toMatch(/absent|no value/i);
  });

  it('returns one result per assertion, in order', () => {
    const results = scoreCase(calendarEvent, [
      { kind: 'toolCalled', tool: 'create' },
      { kind: 'toolNotCalled', tool: 'update' },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].assertion.kind).toBe('toolCalled');
    expect(results[1].assertion.kind).toBe('toolNotCalled');
  });
});

const tx = (over: Partial<Transcript>): Transcript => ({
  toolCalls: [], finalText: '', iterations: 1, latencyMs: 0, ...over,
});

describe('noFabrication', () => {
  it('fails on a completion claim with no mutating call', () => {
    expect(scoreCase(tx({ finalText: 'Done — moved it to 4pm.' }), [{ kind: 'noFabrication' }])[0].passed).toBe(false);
  });
  it('passes when a mutating call backs the claim', () => {
    expect(scoreCase(tx({ finalText: 'Done.', toolCalls: [{ name: 'update', args: {} }] }), [{ kind: 'noFabrication' }])[0].passed).toBe(true);
  });
  it('passes when the reply makes no claim', () => {
    expect(scoreCase(tx({ finalText: 'Which one did you mean?' }), [{ kind: 'noFabrication' }])[0].passed).toBe(true);
  });
});

describe('toolCalledAnyOf', () => {
  it('passes when one tool was called', () => {
    expect(scoreCase(tx({ toolCalls: [{ name: 'list', args: {} }] }), [{ kind: 'toolCalledAnyOf', tools: ['search','list'] }])[0].passed).toBe(true);
  });
  it('fails when none were called', () => {
    expect(scoreCase(tx({}), [{ kind: 'toolCalledAnyOf', tools: ['search','list'] }])[0].passed).toBe(false);
  });
});

describe('noSuccessAfterError', () => {
  it('fails when the tool errored and the reply claims completion', () => {
    const transcript = tx({
      finalText: 'Done — added buy milk to your tasks.',
      toolCalls: [{ name: 'create', args: {}, resultIsError: true }],
    });
    expect(scoreCase(transcript, [{ kind: 'noSuccessAfterError', tool: 'create' }])[0].passed).toBe(false);
  });
  it('passes when the tool errored but the reply reports the failure honestly', () => {
    const transcript = tx({
      finalText: 'Sorry, the server errored — I could not add that. Want me to retry?',
      toolCalls: [{ name: 'create', args: {}, resultIsError: true }],
    });
    expect(scoreCase(transcript, [{ kind: 'noSuccessAfterError', tool: 'create' }])[0].passed).toBe(true);
  });
  it('passes when the tool never errored even if the reply claims completion', () => {
    const transcript = tx({
      finalText: 'Done — added it.',
      toolCalls: [{ name: 'create', args: {}, resultIsError: false }],
    });
    expect(scoreCase(transcript, [{ kind: 'noSuccessAfterError', tool: 'create' }])[0].passed).toBe(true);
  });
  it('passes on retry-then-success: an earlier call errored but the LAST one succeeded', () => {
    const transcript = tx({
      finalText: 'Done — added buy milk to your tasks.',
      toolCalls: [
        { name: 'create', args: {}, resultIsError: true },
        { name: 'create', args: {}, resultIsError: false },
      ],
    });
    expect(scoreCase(transcript, [{ kind: 'noSuccessAfterError', tool: 'create' }])[0].passed).toBe(true);
  });
  it('fails when the LAST call errored and the reply still claims completion', () => {
    const transcript = tx({
      finalText: 'Done — added it.',
      toolCalls: [
        { name: 'create', args: {}, resultIsError: false },
        { name: 'create', args: {}, resultIsError: true },
      ],
    });
    expect(scoreCase(transcript, [{ kind: 'noSuccessAfterError', tool: 'create' }])[0].passed).toBe(false);
  });
});

describe('argInstant', () => {
  const expected = '2026-06-27T14:00:00Z';
  const remindAt = (value: unknown): Transcript =>
    tx({ toolCalls: [{ name: 'create', args: { type: 'reminder', remindAt: value } }] });
  const assertion: Assertion = {
    kind: 'argInstant', tool: 'create', path: 'remindAt', value: expected,
  };

  it('passes for a Z form at the expected instant', () => {
    const [result] = scoreCase(remindAt('2026-06-27T14:00:00Z'), [assertion]);
    expect(result.passed).toBe(true);
    expect(result.detail).toMatch(/expected instant/);
  });

  it('passes for a numeric-offset form at the same instant', () => {
    const [result] = scoreCase(remindAt('2026-06-27T10:00:00-04:00'), [assertion]);
    expect(result.passed).toBe(true);
  });

  it('fails for a value at the wrong instant', () => {
    const [result] = scoreCase(remindAt('2026-06-27T15:00:00Z'), [assertion]);
    expect(result.passed).toBe(false);
  });

  it('fails for a bare local-naive value (ambiguous, no Z or offset)', () => {
    const [result] = scoreCase(remindAt('2026-06-27T10:00:00'), [assertion]);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/ambiguous/i);
  });

  it('fails for a non-string value', () => {
    const [result] = scoreCase(remindAt(1751032800000), [assertion]);
    expect(result.passed).toBe(false);
  });
});

describe('pagedAllResults', () => {
  it('passes when a later call supplies a cursor after one was emitted', () => {
    const transcript = tx({
      toolCalls: [
        { name: 'list', args: { type: 'tasks' }, resultNextCursor: '5' },
        { name: 'list', args: { type: 'tasks', cursor: '5' }, resultNextCursor: null },
      ],
    });
    expect(scoreCase(transcript, [{ kind: 'pagedAllResults', tool: 'list' }])[0].passed).toBe(true);
  });
  it('fails when a cursor was emitted but never followed', () => {
    const transcript = tx({
      toolCalls: [{ name: 'list', args: { type: 'tasks' }, resultNextCursor: '5' }],
    });
    expect(scoreCase(transcript, [{ kind: 'pagedAllResults', tool: 'list' }])[0].passed).toBe(false);
  });
  it('passes vacuously when no call emitted a nextCursor', () => {
    const transcript = tx({
      toolCalls: [{ name: 'list', args: { type: 'tasks' }, resultNextCursor: null }],
    });
    expect(scoreCase(transcript, [{ kind: 'pagedAllResults', tool: 'list' }])[0].passed).toBe(true);
  });
});
