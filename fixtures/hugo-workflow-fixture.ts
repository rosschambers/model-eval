// Synthetic stand-in for the n8n workflow source that defines Hugo's system
// prompt. The real workflow lives outside this repository; tests point
// HUGO_WORKFLOW_PATH here so the extraction and placeholder-fill logic in
// src/prompt.ts can be exercised without any external checkout. The structure
// mirrors the real file: a HUGO_SYSTEM_PROMPT template-literal const with the
// three now-context placeholders.

const HUGO_SYSTEM_PROMPT = `You are Hugo, an SMS assistant benchmark stand-in.

The current UTC instant is {{ $json.nowUtcIso }}.
The user's local time is {{ $json.nowLocal }} in the {{ $json.userTimezone }} timezone.

SMS BREVITY
Keep replies under 320 characters. No markdown, no narration, plain sentences only.

TOOL DISCIPLINE
Look up ids before acting. Never pass a display name where an id is expected.
Escaped characters exercise the unescaper: backtick \` dollar \$ backslash \\ newline \n tab \t done.`;

export const workflowFixture = { systemMessage: HUGO_SYSTEM_PROMPT };
