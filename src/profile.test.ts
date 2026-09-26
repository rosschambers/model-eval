import { describe, it, expect } from 'vitest';
import { getProfiles, PROFILES } from './profile.js';

describe('profile registry', () => {
  it('throws on an unknown profile id', () => {
    expect(() => getProfiles(['nope'])).toThrow(/unknown profile/i);
  });
  it('returns all profiles when no ids given', () => {
    expect(getProfiles()).toHaveLength(Object.keys(PROFILES).length);
  });
});

describe('time context on every profile that uses the murmur8 portal prompt', () => {
  it('gives voice the same trailing <user-context> clock as murmur8 (the portal prompt carries no time)', () => {
    expect(PROFILES.voice!.buildTrailingUserContext).toBe(PROFILES.murmur8!.buildTrailingUserContext);
    expect(PROFILES.voice!.buildTrailingUserContext).toBeDefined();
  });
});

describe('probe profiles', () => {
  it('reuse the base profile prompt, tools, mocks and time context, with only the cases swapped', () => {
    for (const [probeId, baseId] of [['hugo-probe', 'hugo'], ['murmur8-probe', 'murmur8']] as const) {
      const probe = PROFILES[probeId]!;
      const base = PROFILES[baseId]!;
      expect(probe.buildSystemPrompt).toBe(base.buildSystemPrompt);
      expect(probe.buildUserMessage).toBe(base.buildUserMessage);
      expect(probe.buildTrailingUserContext).toBe(base.buildTrailingUserContext);
      expect(probe.toolDefs).toBe(base.toolDefs);
      expect(probe.replyConstraints).toEqual(base.replyConstraints);
      expect(probe.cases.length).toBeGreaterThanOrEqual(10);
      expect(probe.cases.every((c) => c.id.startsWith('probe-'))).toBe(true);
    }
  });

  it('never reuse a request from the main case sets (they measure generalization, not recall)', () => {
    const mainTexts = new Set(
      ['hugo', 'murmur8'].flatMap((id) => PROFILES[id]!.cases.map((c) => c.sms.toLowerCase())),
    );
    const probeTexts = PROFILES['hugo-probe']!.cases.map((c) => c.sms.toLowerCase());
    expect(probeTexts.filter((text) => mainTexts.has(text))).toEqual([]);
    expect(new Set(probeTexts).size).toBe(probeTexts.length);
  });
});
