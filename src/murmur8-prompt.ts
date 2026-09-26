// Pinned-clock system-prompt builder for the murmur8 in-app agent. Unlike Hugo's
// n8n workflow (which fills {{ }} placeholders), murmur8 injects time/user
// context as a separate system message. We model that by reading the verbatim
// snapshot of the real AI.SystemPrompt and appending a pinned-clock context line.
// The pinned instant matches Hugo's so both profiles share one benchmark clock.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NOW_UTC_ISO, USER_TIMEZONE, pinnedLocalTime } from './pinned-clock.js';

// The murmur8 PORTAL agent's live system prompt is the `AI:SystemPrompt` string
// inside the API's appsettings.json. Its location MUST be provided via the
// MURMUR8_APPSETTINGS_PATH env var, mirroring how the Hugo loader requires
// HUGO_WORKFLOW_PATH.

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

/** `AI.SystemPrompt` from a murmur8 configuration JSON file, or undefined if absent/empty. */
function systemPromptIn(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { AI?: { SystemPrompt?: unknown } };
  const prompt = parsed.AI?.SystemPrompt;
  return typeof prompt === 'string' && prompt.trim().length > 0 ? prompt : undefined;
}

/**
 * Build the murmur8 PORTAL agent's system prompt: the verbatim `AI.SystemPrompt`
 * (the "SCREEN CONTEXT (CURRENT PAGE):" instructions the in-app agent runs with),
 * resolved with the same layering production uses since murmur8 128be8d4: the host's
 * appsettings.json wins, else the shared `Murmur8.Infrastructure/AI/ai-prompts.json`
 * (an embedded resource both hosts load BELOW their appsettings). The appsettings
 * path comes from the required MURMUR8_APPSETTINGS_PATH env var; the shared file
 * from MURMUR8_AI_PROMPTS_PATH, defaulting to its place beside the Api project.
 * Throws if neither layer has a non-empty `AI.SystemPrompt`.
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
  const sharedPromptsPath =
    process.env.MURMUR8_AI_PROMPTS_PATH ??
    join(dirname(appsettingsPath), '..', 'Murmur8.Infrastructure', 'AI', 'ai-prompts.json');
  const systemPrompt = systemPromptIn(appsettingsPath) ?? systemPromptIn(sharedPromptsPath);
  if (systemPrompt === undefined) {
    throw new Error(
      `AI.SystemPrompt not found in ${appsettingsPath} or ${sharedPromptsPath}. The murmur8 ` +
        'portal prompt loader expects a non-empty AI.SystemPrompt in the host appsettings or ' +
        'the shared Infrastructure/AI/ai-prompts.json.',
    );
  }
  // Verbatim: the portal agent's time context is NOT part of its system prompt — it
  // arrives as a trailing <user-context> system message (buildMurmur8UserContext).
  return systemPrompt.trimEnd();
}

/**
 * The trailing `<user-context>` system message the murmur8 portal agent appends
 * to every LLM call, after history and screen-context, for KV-cache reuse
 * (`Murmur8.Application/AI/ChatMessageBuilder.cs::BuildUserContextMessage`,
 * C# formats `dddd, MMMM d, yyyy h:mm tt` and `yyyy-MM-ddTHH:mm:ssZ`), filled
 * from the pinned benchmark clock.
 */
export function buildMurmur8UserContext(): string {
  // C#'s `dddd, MMMM d, yyyy h:mm tt` has no " at " between date and time.
  const localNow = pinnedLocalTime().replace(' at ', ' ');
  return (
    `<user-context timezone="${USER_TIMEZONE}">\n` +
    `Current local time: ${localNow}. Current UTC time: ${NOW_UTC_ISO}.\n` +
    '</user-context>'
  );
}
