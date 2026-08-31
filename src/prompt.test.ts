import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystemPrompt } from './prompt.js';

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
