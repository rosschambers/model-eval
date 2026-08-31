import { describe, it, expect } from 'vitest';
import { buildMurmur8SystemPrompt, buildMurmur8PortalPrompt } from './murmur8-prompt.js';

describe('murmur8 system prompt', () => {
  it('loads a non-empty prompt with injected local time', () => {
    const p = buildMurmur8SystemPrompt();
    expect(p.length).toBeGreaterThan(100);
    expect(p).toContain('America/Detroit');
    expect(p).toMatch(/Current time:/);
  });
});

describe('murmur8 portal system prompt', () => {
  it('loads the PORTAL prompt from AI.SystemPrompt with the screen-context section', () => {
    const p = buildMurmur8PortalPrompt();
    expect(p.length).toBeGreaterThan(100);
    expect(p).toContain('SCREEN CONTEXT (CURRENT PAGE):');
    expect(p).toContain('active-item');
    expect(p).toContain('active-container');
  });

  it('injects the pinned local time context', () => {
    const p = buildMurmur8PortalPrompt();
    expect(p).toContain('America/Detroit');
    expect(p).toMatch(/Current time:/);
  });

  it('honors the MURMUR8_APPSETTINGS_PATH env override', () => {
    const original = process.env.MURMUR8_APPSETTINGS_PATH;
    process.env.MURMUR8_APPSETTINGS_PATH = '/nonexistent/appsettings.json';
    try {
      expect(() => buildMurmur8PortalPrompt()).toThrow();
    } finally {
      if (original === undefined) {
        delete process.env.MURMUR8_APPSETTINGS_PATH;
      } else {
        process.env.MURMUR8_APPSETTINGS_PATH = original;
      }
    }
  });
});
