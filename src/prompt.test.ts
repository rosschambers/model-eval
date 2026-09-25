import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystemPrompt, buildUserMessage } from './prompt.js';

describe('buildSystemPrompt', () => {
  const prompt = buildSystemPrompt();

  it('contains Hugo identity', () => {
    expect(prompt).toContain('You are Hugo');
  });

  it('fills the pinned UTC instant and timezone', () => {
    expect(prompt).toContain('2026-06-26T18:00:00Z');
    expect(prompt).toContain('America/Detroit');
  });

  it('fills the local now-context (date and time, separator-agnostic)', () => {
    expect(prompt).toContain('June 26, 2026');
    expect(prompt).toContain('2:00');
  });

  it('substitutes all placeholders', () => {
    expect(prompt).not.toContain('{{');
  });

  it('preserves a known section header from the real prompt', () => {
    expect(prompt).toContain('SMS BREVITY');
  });

  it('honors HUGO_WORKFLOW_PATH and fills placeholders from the override file', () => {
    const previous = process.env.HUGO_WORKFLOW_PATH;
    const dir = mkdtempSync(join(tmpdir(), 'hugo-prompt-'));
    const file = join(dir, 'workflow.ts');
    writeFileSync(file, 'const HUGO_SYSTEM_PROMPT = `hi {{ $json.userTimezone }}`;', 'utf8');
    try {
      process.env.HUGO_WORKFLOW_PATH = file;
      const result = buildSystemPrompt();
      expect(result).toContain('hi ');
      expect(result).toContain('America/Detroit');
    } finally {
      if (previous === undefined) {
        delete process.env.HUGO_WORKFLOW_PATH;
      } else {
        process.env.HUGO_WORKFLOW_PATH = previous;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Point HUGO_WORKFLOW_PATH at a temporary workflow source for one assertion block. */
function withWorkflow(source: string, run: () => void): void {
  const previous = process.env.HUGO_WORKFLOW_PATH;
  const dir = mkdtempSync(join(tmpdir(), 'hugo-user-'));
  const file = join(dir, 'workflow.ts');
  writeFileSync(file, source, 'utf8');
  try {
    process.env.HUGO_WORKFLOW_PATH = file;
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.HUGO_WORKFLOW_PATH;
    } else {
      process.env.HUGO_WORKFLOW_PATH = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// Production shape since n8n commit 50cb455 (2026-09-12): the time context left the
// system prompt and is appended to the user message by the agent node's `text` template.
const PRODUCTION_WORKFLOW =
  'const HUGO_SYSTEM_PROMPT = `You are Hugo. Read the time context at the end of the request.`;\n' +
  'const agent = node({ parameters: {\n' +
  '  text: expr("{{ $json.userPrompt }}\\n\\n--- REQUEST CONTEXT ---\\nCurrent time (UTC): {{ $json.nowUtcIso }}\\nCurrent time (user local): {{ $json.nowLocal }}\\nUser timezone: {{ $json.userTimezone }}"),\n' +
  '} });\n';

describe('buildUserMessage', () => {
  it('appends the production REQUEST CONTEXT with the pinned clock after the sms', () => {
    withWorkflow(PRODUCTION_WORKFLOW, () => {
      const message = buildUserMessage('remind me to call mom at 6pm');

      expect(message.startsWith('remind me to call mom at 6pm\n\n--- REQUEST CONTEXT ---\n')).toBe(true);
      expect(message).toContain('Current time (UTC): 2026-06-26T18:00:00Z');
      expect(message).toContain('June 26, 2026');
      expect(message).toContain('User timezone: America/Detroit');
      expect(message).not.toContain('{{');
    });
  });

  it('returns the sms unchanged for a legacy workflow whose system prompt carries the time', () => {
    withWorkflow('const HUGO_SYSTEM_PROMPT = `Now: {{ $json.nowLocal }}`;', () => {
      expect(buildUserMessage('what is on today')).toBe('what is on today');
    });
  });

  it('fails loud when the workflow gives the model no time context anywhere', () => {
    withWorkflow('const HUGO_SYSTEM_PROMPT = `You are Hugo.`;', () => {
      expect(() => buildUserMessage('what is on today')).toThrow(/no time context/);
    });
  });
});
