import { describe, it, expect } from 'vitest';
import { hugoProfile } from './hugo.js';

describe('hugo profile', () => {
  it('has the SMS reply constraints', () => {
    expect(hugoProfile.replyConstraints).toEqual({ maxChars: 320, allowMarkdown: false, allowNarration: false });
  });
  it('exposes the Murmur8 tool surface including the code tools', () => {
    const names = hugoProfile.toolDefs.map((t) => t.function.name);
    expect(names).toContain('Parse_Date_Time');
    expect(names).toContain('Convert_Time');
  });
  it('carries the existing case set', () => {
    expect(hugoProfile.cases.length).toBeGreaterThan(30);
  });
});
