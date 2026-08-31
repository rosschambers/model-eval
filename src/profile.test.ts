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
