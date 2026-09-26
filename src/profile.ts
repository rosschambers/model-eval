// AgentProfile abstraction. A profile bundles everything the runner needs to
// drive one agent persona through the benchmark: its system prompt builder, its
// tool surface, its default tool mocks, the reply constraints used by reply
// grading, and the set of cases it should be measured against. The PROFILES
// registry maps a stable id to each profile; getProfiles resolves a selection.

import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { MockMap } from './mock-engine.js';
import type { BenchCase } from './case.js';
import { hugoProfile } from './profiles/hugo.js';
import { murmur8Profile } from './profiles/murmur8.js';
import { homeProfile } from './profiles/home.js';
import { voiceProfile } from './profiles/voice.js';
import { hugoProbeProfile, murmur8ProbeProfile } from './profiles/probe.js';

export interface ReplyConstraints {
  maxChars: number | null;
  allowMarkdown: boolean;
  allowNarration: boolean;
}

export interface AgentProfile {
  id: string;
  label: string;
  buildSystemPrompt: () => string;
  /** Wrap a case's raw sms the way production builds the user turn (for example, appending a time context). */
  buildUserMessage?: (sms: string) => string;
  /** Per-request trailing context system message (for example murmur8's <user-context> clock). */
  buildTrailingUserContext?: () => string;
  toolDefs: ChatCompletionTool[];
  mockDefaults: MockMap;
  replyConstraints: ReplyConstraints;
  cases: BenchCase[];
}

export const PROFILES: Record<string, AgentProfile> = {
  hugo: hugoProfile,
  murmur8: murmur8Profile,
  home: homeProfile,
  voice: voiceProfile,
  'hugo-probe': hugoProbeProfile,
  'murmur8-probe': murmur8ProbeProfile,
};

/**
 * Resolve a profile selection. With no ids, returns every registered profile.
 * With ids, returns the named subset in the given order, throwing on an
 * unknown id.
 */
export function getProfiles(ids?: string[]): AgentProfile[] {
  if (!ids) return Object.values(PROFILES);
  return ids.map((id) => {
    const profile = PROFILES[id];
    if (!profile) throw new Error(`unknown profile: ${id}`);
    return profile;
  });
}
