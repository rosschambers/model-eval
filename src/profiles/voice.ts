// voice profile — the murmur8 productivity tool surface as reached by voice.
// Same Murmur8 MCP tools and portal system prompt as the `murmur8` profile
// (calendar, tasks, reminders, email, files), but the reply contract is
// speakable: capped length, no markdown, no narration — because voice output
// is spoken, not rendered. The eval case set is a later task; this is the
// profile-shape snapshot only.

import type { AgentProfile } from '../profile.js';
import { buildMurmur8PortalPrompt, buildMurmur8UserContext } from '../murmur8-prompt.js';
import { getMurmur8ToolDefs } from '../tools-murmur8.js';
import { defaultMocks } from '../mock-engine.js';

export const voiceProfile: AgentProfile = {
  id: 'voice',
  label: 'Voice (murmur8 productivity tools by voice)',
  buildSystemPrompt: buildMurmur8PortalPrompt,
  // The portal prompt carries no time; like murmur8, the clock is a trailing <user-context>.
  buildTrailingUserContext: buildMurmur8UserContext,
  toolDefs: getMurmur8ToolDefs(),
  mockDefaults: defaultMocks,
  replyConstraints: { maxChars: 320, allowMarkdown: false, allowNarration: false },
  cases: [],
};
