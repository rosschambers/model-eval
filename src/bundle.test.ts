import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBundle, writeBundle } from './bundle.js';
import type { AgentProfile } from './profile.js';
import type { RawRecord } from './run.js';

const profiles = [
  {
    id: 'hugo',
    label: 'Hugo',
    buildSystemPrompt: () => '',
    toolDefs: [],
    mockDefaults: {},
    replyConstraints: { maxChars: 320, allowMarkdown: false, allowNarration: false },
    cases: [
      {
        id: 'cal-01',
        capability: 'cal',
        sms: 'book it',
        expect: [],
        replyRubric: 'Confirms the meeting at 3pm Friday.',
      },
    ],
  } as unknown as AgentProfile,
];

function rec(over: Partial<RawRecord>): RawRecord {
  return {
    profile: 'hugo',
    caseId: 'cal-01',
    capability: 'cal',
    model: 'haiku',
    repeat: 0,
    transcript: { toolCalls: [], finalText: '', iterations: 1, latencyMs: 0 },
    scores: [],
    ...over,
  };
}

describe('buildBundle', () => {
  it('includes the case rubric and the reply text for a non-error record', () => {
    const md = buildBundle(
      [rec({ transcript: { toolCalls: [], finalText: 'Booked for 3pm Friday.', iterations: 1, latencyMs: 5 } })],
      profiles,
    );
    expect(md).toContain('Confirms the meeting at 3pm Friday.');
    expect(md).toContain('Booked for 3pm Friday.');
    expect(md).toContain('cal-01');
  });

  it('lists errored records under a Skipped section', () => {
    const md = buildBundle([rec({ transcript: null, scores: [], error: 'boom' })], profiles);
    expect(md).toContain('## Skipped (errored)');
    expect(md).toContain('boom');
  });
});

describe('writeBundle', () => {
  it('writes judging-bundle.md into the dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    writeBundle(dir, [rec({})], profiles);
    const md = readFileSync(join(dir, 'judging-bundle.md'), 'utf8');
    expect(md).toContain('cal-01');
  });
});
