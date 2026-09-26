import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('murmur8 portal prompt layering (murmur8 128be8d4: shared ai-prompts.json below host appsettings)', () => {
  function layout(appsettings: unknown, prompts?: unknown): string {
    const root = mkdtempSync(join(tmpdir(), 'murmur8-layout-'));
    mkdirSync(join(root, 'src/Murmur8.Api'), { recursive: true });
    mkdirSync(join(root, 'src/Murmur8.Infrastructure/AI'), { recursive: true });
    const appsettingsPath = join(root, 'src/Murmur8.Api/appsettings.json');
    writeFileSync(appsettingsPath, JSON.stringify(appsettings));
    if (prompts !== undefined) {
      writeFileSync(join(root, 'src/Murmur8.Infrastructure/AI/ai-prompts.json'), JSON.stringify(prompts));
    }
    return appsettingsPath;
  }

  function withAppsettings(path: string, run: () => void): void {
    const original = process.env.MURMUR8_APPSETTINGS_PATH;
    process.env.MURMUR8_APPSETTINGS_PATH = path;
    try {
      run();
    } finally {
      if (original === undefined) delete process.env.MURMUR8_APPSETTINGS_PATH;
      else process.env.MURMUR8_APPSETTINGS_PATH = original;
    }
  }

  it('falls back to the shared Infrastructure/AI/ai-prompts.json when appsettings has no SystemPrompt', () => {
    const path = layout({ AI: { Model: 'x' } }, { AI: { SystemPrompt: 'shared portal prompt' } });
    withAppsettings(path, () => expect(buildMurmur8PortalPrompt()).toBe('shared portal prompt'));
  });

  it('lets a host appsettings SystemPrompt override the shared one, as the configuration layering does', () => {
    const path = layout({ AI: { SystemPrompt: 'host override' } }, { AI: { SystemPrompt: 'shared portal prompt' } });
    withAppsettings(path, () => expect(buildMurmur8PortalPrompt()).toBe('host override'));
  });

  it('throws when neither layer has a SystemPrompt', () => {
    const path = layout({ AI: {} });
    withAppsettings(path, () => expect(() => buildMurmur8PortalPrompt()).toThrow(/SystemPrompt/));
  });
});
