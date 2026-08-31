// Hugo profile — the production n8n SMS agent (the Murmur8 domain assistant).
// Wraps the existing prompt builder, tool surface, default mocks, and case set
// into the AgentProfile shape so the runner can drive it like any other persona.

import type { AgentProfile } from '../profile.js';
import { buildSystemPrompt } from '../prompt.js';
import { getToolDefs } from '../tools.js';
import { defaultMocks } from '../mock-engine.js';
import { CASES } from '../cases.js';
import { FIDELITY_CASES } from '../cases-fidelity.js';

export const hugoProfile: AgentProfile = {
  id: 'hugo',
  label: 'Hugo (n8n SMS agent)',
  buildSystemPrompt,
  toolDefs: getToolDefs(),
  mockDefaults: defaultMocks,
  replyConstraints: { maxChars: 320, allowMarkdown: false, allowNarration: false },
  cases: [...CASES, ...FIDELITY_CASES],
};
