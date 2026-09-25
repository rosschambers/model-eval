import { describe, it, expect } from 'vitest';
import {
  buildMurmur8SystemPrompt,
  buildMurmur8PortalPrompt,
  buildMurmur8UserContext,
} from './murmur8-prompt.js';

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

  it('keeps the time OUT of the portal system prompt (production sends it as a trailing <user-context>)', () => {
    const p = buildMurmur8PortalPrompt();
    expect(p).not.toMatch(/Current time:/);
  });
});

describe('murmur8 trailing user-context', () => {
  it('renders the exact ChatMessageBuilder.BuildUserContextMessage block for the pinned clock', () => {
    expect(buildMurmur8UserContext()).toBe(
      '<user-context timezone="America/Detroit">\n' +
        'Current local time: Friday, June 26, 2026 2:00 PM. Current UTC time: 2026-06-26T18:00:00Z.\n' +
        '</user-context>',
    );
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
