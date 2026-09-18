// Caller-contract test — a current-surface snapshot of each caller's model
// interface. Every caller (Hugo/SMS, murmur8/portal, home/Home Assistant voice,
// voice/productivity-by-voice) presents a distinct tool surface and reply
// contract to the model. This test pins those contracts so a future tool or
// prompt change that silently breaks one surface fails loudly here, and so the
// v6/v7 boundary (no garage, climate/thermostat, or camera tools yet) is
// enforced rather than assumed.

import { describe, it, expect } from 'vitest';
import { getProfiles, PROFILES } from './profile.js';
import { hugoProfile } from './profiles/hugo.js';
import { murmur8Profile } from './profiles/murmur8.js';
import { homeProfile } from './profiles/home.js';
import { voiceProfile } from './profiles/voice.js';

const SPEAKABLE_PROFILES = [
  ['hugo', hugoProfile],
  ['home', homeProfile],
  ['voice', voiceProfile],
] as const;

describe('caller contract: speakable surfaces', () => {
  for (const [name, profile] of SPEAKABLE_PROFILES) {
    it(`${name} has speakable reply constraints`, () => {
      expect(profile.replyConstraints.maxChars).not.toBeNull();
      expect(typeof profile.replyConstraints.maxChars).toBe('number');
      expect(profile.replyConstraints.allowMarkdown).toBe(false);
      expect(profile.replyConstraints.allowNarration).toBe(false);
    });
  }
});

describe('caller contract: portal is a distinct, richer contract', () => {
  it('murmur8 (portal) allows longer, markdown replies', () => {
    expect(murmur8Profile.replyConstraints).toEqual({
      maxChars: null,
      allowMarkdown: true,
      allowNarration: false,
    });
  });
});

describe('caller contract: home is the v6 current-surface snapshot (no v7 tools)', () => {
  it('excludes garage/cover, climate/thermostat, and camera tools', () => {
    const names = homeProfile.toolDefs.map((t) => t.function.name);
    for (const name of names) {
      expect(name).not.toMatch(/garage|cover|climate|thermostat|camera/i);
    }
  });

  it('includes the current live Home Assistant surface', () => {
    const names = homeProfile.toolDefs.map((t) => t.function.name);
    expect(names).toContain('HassLightSet');
    expect(names).toContain('HassMediaSearchAndPlay');
    expect(names).toContain('todo_get_items');
  });
});

describe('caller contract: every profile exposes valid OpenAI function tools', () => {
  for (const profile of Object.values(PROFILES)) {
    it(`${profile.id} toolDefs are all well-formed function tools`, () => {
      expect(profile.toolDefs.length).toBeGreaterThan(0);
      for (const tool of profile.toolDefs) {
        expect(tool.type).toBe('function');
        expect(typeof tool.function.name).toBe('string');
        expect(tool.function.name.length).toBeGreaterThan(0);
        expect(tool.function.parameters).toBeDefined();
      }
    });
  }
});

describe('caller contract: profile resolution', () => {
  it('getProfiles(["home", "voice"]) resolves in the given order', () => {
    const resolved = getProfiles(['home', 'voice']);
    expect(resolved.map((p) => p.id)).toEqual(['home', 'voice']);
  });

  it('getProfiles(["nope"]) throws on an unknown id', () => {
    expect(() => getProfiles(['nope'])).toThrow(/unknown profile/i);
  });
});
