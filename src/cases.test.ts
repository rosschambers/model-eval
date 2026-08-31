import { describe, it, expect } from 'vitest';
import { CASES } from './cases.js';
import { FIDELITY_CASES } from './cases-fidelity.js';

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
  'sms-brevity',
];

describe('CASES', () => {
  it('has at least 32 cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(32);
  });

  it('has unique ids', () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has at least 3 cases for every required capability', () => {
    for (const capability of REQUIRED_CAPABILITIES) {
      const count = CASES.filter((c) => c.capability === capability).length;
      expect(count, `capability ${capability}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('only uses the required capability strings', () => {
    for (const c of CASES) {
      expect(REQUIRED_CAPABILITIES, `case ${c.id}`).toContain(c.capability);
    }
  });

  it('gives every case a non-empty expect array', () => {
    for (const c of CASES) {
      expect(Array.isArray(c.expect), `case ${c.id}`).toBe(true);
      expect(c.expect.length, `case ${c.id}`).toBeGreaterThan(0);
    }
  });

  it('gives every case a non-empty replyRubric', () => {
    for (const c of CASES) {
      expect(typeof c.replyRubric, `case ${c.id}`).toBe('string');
      expect((c.replyRubric ?? '').trim().length, `case ${c.id}`).toBeGreaterThan(0);
    }
  });

  it('gives every case a non-empty sms', () => {
    for (const c of CASES) {
      expect((c.sms ?? '').trim().length, `case ${c.id}`).toBeGreaterThan(0);
    }
  });
});

const FIDELITY_CAPABILITIES = [
  'fabrication-bait',
  'error-recovery',
  'pagination',
  'timezone-dst',
];

describe('FIDELITY_CASES', () => {
  it('covers every new fidelity capability at least once', () => {
    for (const capability of FIDELITY_CAPABILITIES) {
      const count = FIDELITY_CASES.filter((c) => c.capability === capability).length;
      expect(count, `capability ${capability}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('only uses the new fidelity capability strings', () => {
    for (const c of FIDELITY_CASES) {
      expect(FIDELITY_CAPABILITIES, `case ${c.id}`).toContain(c.capability);
    }
  });

  it('gives every case a non-empty expect array', () => {
    for (const c of FIDELITY_CASES) {
      expect(Array.isArray(c.expect), `case ${c.id}`).toBe(true);
      expect(c.expect.length, `case ${c.id}`).toBeGreaterThan(0);
    }
  });

  it('gives every case a non-empty sms and replyRubric', () => {
    for (const c of FIDELITY_CASES) {
      expect((c.sms ?? '').trim().length, `case ${c.id}`).toBeGreaterThan(0);
      expect((c.replyRubric ?? '').trim().length, `case ${c.id}`).toBeGreaterThan(0);
    }
  });

  it('has ids unique across the combined CASES + FIDELITY_CASES set', () => {
    const ids = [...CASES, ...FIDELITY_CASES].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
