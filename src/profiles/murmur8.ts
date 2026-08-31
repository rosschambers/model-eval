// murmur8 profile — the in-app portal agent. Same Murmur8 MCP tool surface as
// Hugo, but driven as multi-turn portal chat: no 320-char SMS cap, markdown
// allowed, and WITHOUT the two n8n code-tool helpers. Uses the live PORTAL system
// prompt (AI.SystemPrompt from the API's appsettings.json, which carries the
// SCREEN CONTEXT instructions) so the benchmark measures screen-context / active-
// item handling. Wraps that prompt builder, the tool surface, default mocks, and
// case set into the AgentProfile shape.

import type { AgentProfile } from '../profile.js';
import { buildMurmur8PortalPrompt } from '../murmur8-prompt.js';
import { getMurmur8ToolDefs } from '../tools-murmur8.js';
import { defaultMocks } from '../mock-engine.js';
import { MURMUR8_CASES } from '../cases-murmur8.js';

export const murmur8Profile: AgentProfile = {
  id: 'murmur8',
  label: 'murmur8 (in-app agent)',
  buildSystemPrompt: buildMurmur8PortalPrompt,
  toolDefs: getMurmur8ToolDefs(),
  mockDefaults: defaultMocks,
  replyConstraints: { maxChars: null, allowMarkdown: true, allowNarration: false },
  cases: MURMUR8_CASES,
};
