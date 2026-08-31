// Pinned-clock system-prompt builder for the murmur8 in-app agent. Unlike Hugo's
// n8n workflow (which fills {{ }} placeholders), murmur8 injects time/user
// context as a separate system message. We model that by reading the verbatim
// snapshot of the real AI.SystemPrompt and appending a pinned-clock context line.
// The pinned instant matches Hugo's so both profiles share one benchmark clock.

import { readFileSync } from 'node:fs';

// Pinned instant for the benchmark clock (same as Hugo).
const NOW_UTC_ISO = '2026-06-26T18:00:00Z';
const USER_TIMEZONE = 'America/Detroit';

// The murmur8 PORTAL agent's live system prompt is the `AI:SystemPrompt` string
// inside the API's appsettings.json. Its location MUST be provided via the
// MURMUR8_APPSETTINGS_PATH env var, mirroring how the Hugo loader requires
// HUGO_WORKFLOW_PATH.

/** Format the pinned instant as the user's local wall-clock time. */
function pinnedLocalTime(): string {
  return new Date(NOW_UTC_ISO).toLocaleString('en-US', {
    timeZone: USER_TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Build the murmur8 system prompt: the verbatim snapshot plus a pinned-clock
 * context line, mirroring how murmur8 injects time/user context at runtime.
 */
export function buildMurmur8SystemPrompt(): string {
  const promptUrl = new URL('../fixtures/murmur8-system-prompt.txt', import.meta.url);
  const base = readFileSync(promptUrl, 'utf8').trimEnd();
  const nowLocal = pinnedLocalTime();
  return `${base}\n\nCurrent time: ${nowLocal} (${USER_TIMEZONE}).`;
}

/**
 * Build the murmur8 PORTAL agent's system prompt: the verbatim `AI.SystemPrompt`
 * from the API's appsettings.json (which contains the "SCREEN CONTEXT (CURRENT
 * PAGE):" instructions the in-app agent runs with) plus a pinned-clock context
 * line. The appsettings path comes from the required MURMUR8_APPSETTINGS_PATH
 * env var. Throws if the env var is unset, the file cannot be read, or it does
 * not contain an `AI.SystemPrompt` string.
 */
export function buildMurmur8PortalPrompt(): string {
  const appsettingsPath = process.env.MURMUR8_APPSETTINGS_PATH;
  if (!appsettingsPath) {
    throw new Error(
      'MURMUR8_APPSETTINGS_PATH is not set. Point it at an appsettings.json whose ' +
        'AI.SystemPrompt holds the murmur8 portal agent system prompt ' +
        '(for tests, fixtures/murmur8-appsettings-fixture.json).',
    );
  }
  const raw = readFileSync(new URL(`file://${appsettingsPath}`), 'utf8');
  const parsed = JSON.parse(raw) as { AI?: { SystemPrompt?: unknown } };
  const systemPrompt = parsed.AI?.SystemPrompt;
  if (typeof systemPrompt !== 'string' || systemPrompt.trim().length === 0) {
    throw new Error(
      `AI.SystemPrompt not found (or not a string) in ${appsettingsPath}. ` +
        'The murmur8 portal prompt loader expects a JSON object with a non-empty AI.SystemPrompt.',
    );
  }
  const base = systemPrompt.trimEnd();
  const nowLocal = pinnedLocalTime();
  return `${base}\n\nCurrent time: ${nowLocal} (${USER_TIMEZONE}).`;
}
