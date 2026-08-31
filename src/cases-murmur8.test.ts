import { describe, it, expect } from 'vitest';
import { MURMUR8_CASES } from './cases-murmur8.js';
import { murmur8Profile } from './profiles/murmur8.js';

const REQUIRED_CAPABILITIES = [
  'calendar-create-tz',
  'calendar-lookup',
  'reminders-utc',
  'tasks-crud',
  'complete-on-implication',
  'lists-entity-lookup',
  'search-disambiguation',
  'memory-followup',
  'multi-step',
  'fabrication-bait',
  'pagination',
  'error-recovery',
];

describe('MURMUR8_CASES', () => {
  it('has at least 15 cases', () => {
    expect(MURMUR8_CASES.length).toBeGreaterThanOrEqual(15);
  });

  it('has unique ids', () => {
    const ids = MURMUR8_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every case a non-empty expect array', () => {
    for (const c of MURMUR8_CASES) {
      expect(Array.isArray(c.expect), `case ${c.id}`).toBe(true);
      expect(c.expect.length, `case ${c.id}`).toBeGreaterThan(0);
    }
  });

  it('gives every case a non-empty sms', () => {
    for (const c of MURMUR8_CASES) {
      expect((c.sms ?? '').trim().length, `case ${c.id}`).toBeGreaterThan(0);
    }
  });

  it('covers every required capability at least once', () => {
    for (const capability of REQUIRED_CAPABILITIES) {
      const count = MURMUR8_CASES.filter((c) => c.capability === capability).length;
      expect(count, `capability ${capability}`).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('active-item disambiguation cases', () => {
  const disambiguation = MURMUR8_CASES.filter(
    (c) => c.capability === 'active-item-disambiguation',
  );
  const guardrails = MURMUR8_CASES.filter((c) => c.capability === 'active-item-guardrail');

  it('has at least 6 active-item disambiguation cases', () => {
    expect(disambiguation.length).toBeGreaterThanOrEqual(6);
  });

  it('gives every disambiguation case a screen-context with an active-item', () => {
    for (const c of disambiguation) {
      expect(c.screenContext, `case ${c.id}`).toBeDefined();
      expect(c.screenContext ?? '', `case ${c.id}`).toContain('<active-item');
    }
  });

  it('asserts each disambiguation case calls a mutating tool with the active-item id', () => {
    for (const c of disambiguation) {
      const mutating = c.expect.filter(
        (assertion) => assertion.kind === 'toolCalled' && ['update', 'delete'].includes(assertion.tool),
      );
      expect(mutating.length, `case ${c.id} calls a mutating tool`).toBeGreaterThanOrEqual(1);
      // The id-usage assertion: argEquals or argMatches on an id path of that tool.
      const idAssertion = c.expect.find(
        (assertion) =>
          (assertion.kind === 'argEquals' || assertion.kind === 'argMatches') &&
          /Id$/.test(assertion.path),
      );
      expect(idAssertion, `case ${c.id} asserts the id argument`).toBeDefined();
    }
  });

  it('asserts each disambiguation case does NOT call search or list', () => {
    for (const c of disambiguation) {
      const notCalled = c.expect
        .filter((assertion) => assertion.kind === 'toolNotCalled')
        .map((assertion) => (assertion as { tool: string }).tool);
      expect(notCalled, `case ${c.id} forbids search`).toContain('search');
      expect(notCalled, `case ${c.id} forbids list`).toContain('list');
    }
  });

  it('has at least 1 guardrail case where a named reference still triggers search/list', () => {
    expect(guardrails.length).toBeGreaterThanOrEqual(1);
    for (const c of guardrails) {
      expect(c.screenContext, `case ${c.id}`).toBeDefined();
      expect(c.screenContext ?? '', `case ${c.id}`).toContain('<active-item');
      const anyOf = c.expect.find((assertion) => assertion.kind === 'toolCalledAnyOf');
      expect(anyOf, `case ${c.id} requires search/list`).toBeDefined();
      const tools = (anyOf as { tools: string[] } | undefined)?.tools ?? [];
      expect(tools).toContain('search');
      expect(tools).toContain('list');
    }
  });
});

describe('murmur8 profile', () => {
  it('has no code tools (Parse_Date_Time / Convert_Time excluded)', () => {
    const names = murmur8Profile.toolDefs.map((t) => t.function.name);
    expect(names).not.toContain('Parse_Date_Time');
    expect(names).not.toContain('Convert_Time');
  });

  it('exposes the core Murmur8 tool surface', () => {
    const names = murmur8Profile.toolDefs.map((t) => t.function.name);
    expect(names).toContain('create');
    expect(names).toContain('list');
    expect(names).toContain('search');
  });

  it('has portal reply constraints (no char cap, markdown allowed)', () => {
    expect(murmur8Profile.replyConstraints.maxChars).toBeNull();
    expect(murmur8Profile.replyConstraints.allowMarkdown).toBe(true);
    expect(murmur8Profile.replyConstraints.allowNarration).toBe(false);
  });

  it('carries the murmur8 case set', () => {
    expect(murmur8Profile.cases).toBe(MURMUR8_CASES);
  });

  it('uses the portal system prompt (has the SCREEN CONTEXT section)', () => {
    const prompt = murmur8Profile.buildSystemPrompt();
    expect(prompt).toContain('SCREEN CONTEXT (CURRENT PAGE):');
  });
});
