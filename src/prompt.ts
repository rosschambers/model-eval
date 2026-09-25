// Pinned-clock system-prompt builder. Reproduces Hugo's EXACT system message by
// extracting the `HUGO_SYSTEM_PROMPT` template-literal const from the real workflow
// source (workflows/domain-murmur8.ts) and filling the now-context placeholders from
// a PINNED clock so the prompt is both faithful to production and deterministic for
// benchmarking.

import { readFileSync } from 'node:fs';
import { NOW_UTC_ISO, USER_TIMEZONE, pinnedLocalTime } from './pinned-clock.js';

// Matches the `const HUGO_SYSTEM_PROMPT = `...`` template literal in the workflow
// source (the prompt was refactored out of an inline single-quoted `expr('...')`
// into a named template-literal const, then passed as `expr(HUGO_SYSTEM_PROMPT)`).
// The capture group holds the raw, still-escaped template-literal contents; it
// stops at the first UNescaped backtick.
const SYSTEM_MESSAGE_RE = /const HUGO_SYSTEM_PROMPT\s*=\s*`((?:[^`\\]|\\.)*)`/s;

/**
 * Unescape raw JavaScript literal contents in a single pass: `\n` and `\t`
 * become control characters, and any other escaped character in `escapable`
 * (the literal's own delimiters plus backslash) becomes itself.
 */
function unescapeLiteral(raw: string, escapable: RegExp): string {
  return raw.replace(escapable, (_, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    return ch;
  });
}

/** Escapes valid inside a template literal (backtick-delimited). */
const TEMPLATE_LITERAL_ESCAPES = /\\([`$\\nt])/g;
/** Escapes valid inside a quoted string literal. */
const STRING_LITERAL_ESCAPES = /\\(["'\\nt])/g;

// Matches the agent node's user-message template, `text: expr("{{ $json.userPrompt }}...")`.
// Since n8n commit 50cb455 (2026-09-12, KV-cache reuse) production appends the time
// context here — a `--- REQUEST CONTEXT ---` block after the user's text — instead of
// in the system prompt. The capture holds the raw, still-escaped string contents.
const USER_MESSAGE_RE = /text:\s*expr\("(\{\{ \$json\.userPrompt \}\}(?:[^"\\]|\\.)*)"\)/;

const NOW_LOCAL_PLACEHOLDER = '{{ $json.nowLocal }}';

interface WorkflowSource {
  source: string;
  path: string;
}

// buildUserMessage runs once per case × repeat; read each workflow file once per
// process. Keyed by path, so pointing HUGO_WORKFLOW_PATH elsewhere reads fresh.
const workflowSourceCache = new Map<string, WorkflowSource>();

function readWorkflowSource(): WorkflowSource {
  const workflowPath = process.env.HUGO_WORKFLOW_PATH;
  if (!workflowPath) {
    throw new Error(
      'HUGO_WORKFLOW_PATH is not set. Point it at the n8n workflow source file that ' +
        'contains the `const HUGO_SYSTEM_PROMPT = `...`` template literal ' +
        '(for tests, fixtures/hugo-workflow-fixture.ts).',
    );
  }
  const cached = workflowSourceCache.get(workflowPath);
  if (cached !== undefined) return cached;

  const workflowUrl = new URL(`file://${workflowPath}`);
  const loaded = { source: readFileSync(workflowUrl, 'utf8'), path: workflowUrl.pathname };
  workflowSourceCache.set(workflowPath, loaded);
  return loaded;
}

function extractSystemTemplate(source: string, path: string): string {
  const match = source.match(SYSTEM_MESSAGE_RE);
  if (!match) {
    throw new Error(
      `Could not find "const HUGO_SYSTEM_PROMPT = \`...\`" in ${path}. ` +
        'The prompt extraction regex did not match — inspect the workflow source.',
    );
  }
  return unescapeLiteral(match[1], TEMPLATE_LITERAL_ESCAPES);
}

/** Fill the n8n now-context placeholders from the pinned benchmark clock. */
function fillNowContext(template: string): string {
  return template
    .split('{{ $json.nowUtcIso }}')
    .join(NOW_UTC_ISO)
    .split(NOW_LOCAL_PLACEHOLDER)
    .join(pinnedLocalTime())
    .split('{{ $json.userTimezone }}')
    .join(USER_TIMEZONE);
}

/**
 * Build Hugo's system prompt with the now-context filled from the pinned clock.
 * Reads the workflow source so the prompt stays faithful to production.
 */
export function buildSystemPrompt(): string {
  const { source, path } = readWorkflowSource();
  return fillNowContext(extractSystemTemplate(source, path));
}

/**
 * Build the user message exactly as production sends it: the sms wrapped in the
 * agent node's `text` template (which carries the REQUEST CONTEXT time block),
 * filled from the pinned clock. A legacy workflow that still puts the time in the
 * system prompt has no such template, so the sms passes through unchanged. A
 * workflow with neither gives the model no date at all — every relative-date case
 * would silently become unwinnable — so that fails loud instead.
 */
export function buildUserMessage(sms: string): string {
  const { source, path } = readWorkflowSource();
  const match = source.match(USER_MESSAGE_RE);
  if (match) {
    return fillNowContext(unescapeLiteral(match[1], STRING_LITERAL_ESCAPES)).split('{{ $json.userPrompt }}').join(sms);
  }
  if (extractSystemTemplate(source, path).includes(NOW_LOCAL_PLACEHOLDER)) {
    return sms;
  }
  throw new Error(
    `${path} gives the model no time context: no "{{ $json.nowLocal }}" in HUGO_SYSTEM_PROMPT ` +
      'and no `text: expr("{{ $json.userPrompt }}...")` user-message template. Update the ' +
      'extraction in src/prompt.ts to match where the workflow now carries the current time.',
  );
}
