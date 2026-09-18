// home profile — the Home Assistant voice assistant. Uses the current-surface
// Hass* tool catalog snapshot (fixtures/home-tools-fixture.json), which is
// deliberately frozen to today's live catalog: no garage/cover, climate/
// thermostat, or camera tools yet (those ship in v7). Voice replies must be
// speakable, so the reply constraints cap length and forbid markdown/narration.
// The eval case set is a later task; this is the profile-shape snapshot only.

import type { AgentProfile } from '../profile.js';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import fixture from '../../fixtures/home-tools-fixture.json' with { type: 'json' };

function buildHomeSystemPrompt(): string {
  return [
    'You are the Home Assistant voice assistant for this house.',
    'You control lights, media players, and todo lists, and you can broadcast',
    'announcements and check the current state of devices and areas.',
    'Answer briefly, in plain speakable sentences — no markdown, no narrating',
    'your own actions, no lists or headings. Say what you did or what you found,',
    'nothing else.',
  ].join(' ');
}

export const homeProfile: AgentProfile = {
  id: 'home',
  label: 'Home (Home Assistant voice assistant)',
  buildSystemPrompt: buildHomeSystemPrompt,
  toolDefs: fixture.tools as ChatCompletionTool[],
  mockDefaults: {},
  replyConstraints: { maxChars: 320, allowMarkdown: false, allowNarration: false },
  cases: [],
};
