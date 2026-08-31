// Pinned-clock system-prompt builder. Reproduces Hugo's EXACT system message by
// extracting the `HUGO_SYSTEM_PROMPT` template-literal const from the real workflow
// source (workflows/domain-murmur8.ts) and filling the now-context placeholders from
// a PINNED clock so the prompt is both faithful to production and deterministic for
// benchmarking.

import { readFileSync } from 'node:fs';

// Pinned instant for the benchmark clock.
const NOW_UTC_ISO = '2026-06-26T18:00:00Z';
const USER_TIMEZONE = 'America/Detroit';

// Matches the `const HUGO_SYSTEM_PROMPT = `...`` template literal in the workflow
// source (the prompt was refactored out of an inline single-quoted `expr('...')`
// into a named template-literal const, then passed as `expr(HUGO_SYSTEM_PROMPT)`).
// The capture group holds the raw, still-escaped template-literal contents; it
// stops at the first UNescaped backtick.
const SYSTEM_MESSAGE_RE = /const HUGO_SYSTEM_PROMPT\s*=\s*`((?:[^`\\]|\\.)*)`/s;

/** Unescape the raw template-literal contents in a single pass. */
function unescapeTemplateLiteral(raw: string): string {
  return raw.replace(/\\([`$\\nt])/g, (_, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    return ch;
  });
}

/**
 * Build Hugo's system prompt with the now-context filled from the pinned clock.
 * Reads the workflow source so the prompt stays faithful to production.
 */
export function buildSystemPrompt(): string {
  const workflowPath = process.env.HUGO_WORKFLOW_PATH;
  if (!workflowPath) {
    throw new Error(
      'HUGO_WORKFLOW_PATH is not set. Point it at the n8n workflow source file that ' +
        'contains the `const HUGO_SYSTEM_PROMPT = `...`` template literal ' +
        '(for tests, fixtures/hugo-workflow-fixture.ts).',
    );
  }
  const workflowUrl = new URL(`file://${workflowPath}`);
  const source = readFileSync(workflowUrl, 'utf8');

  const match = source.match(SYSTEM_MESSAGE_RE);
  if (!match) {
    throw new Error(
      `Could not find "const HUGO_SYSTEM_PROMPT = \`...\`" in ${workflowUrl.pathname}. ` +
        'The prompt extraction regex did not match — inspect the workflow source.',
    );
  }

  const unescaped = unescapeTemplateLiteral(match[1]);

  const nowLocal = new Date(NOW_UTC_ISO).toLocaleString('en-US', {
    timeZone: USER_TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return unescaped
    .split('{{ $json.nowUtcIso }}')
    .join(NOW_UTC_ISO)
    .split('{{ $json.nowLocal }}')
    .join(nowLocal)
    .split('{{ $json.userTimezone }}')
    .join(USER_TIMEZONE);
}
