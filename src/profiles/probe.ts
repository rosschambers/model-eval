// Probe profiles — the hugo and murmur8 profiles unchanged (prompt, tools, mocks,
// time context, reply constraints) with only the case set swapped for the
// held-out PROBE_CASES. Kept separate so the main profiles' scores stay comparable
// with every earlier run.

import type { AgentProfile } from '../profile.js';
import { PROBE_CASES } from '../cases-probe.js';
import { hugoProfile } from './hugo.js';
import { murmur8Profile } from './murmur8.js';

export const hugoProbeProfile: AgentProfile = {
  ...hugoProfile,
  id: 'hugo-probe',
  label: 'Hugo held-out probes',
  cases: PROBE_CASES,
};

export const murmur8ProbeProfile: AgentProfile = {
  ...murmur8Profile,
  id: 'murmur8-probe',
  label: 'murmur8 held-out probes',
  cases: PROBE_CASES,
};
