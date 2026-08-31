import { describe, it, expect } from 'vitest';
import { runOneProfile } from './run.js';
import { hugoProfile } from './profiles/hugo.js';

const stubClient = {
  chat: { completions: { create: async () => ({ choices: [{ message: { content: 'Done.' } }] }) } },
};

describe('runOneProfile', () => {
  it('tags records with the profile id', async () => {
    const records = await runOneProfile(stubClient as any, 'stub-model', hugoProfile, {
      cases: hugoProfile.cases.slice(0, 1), repeat: 1,
    });
    expect(records[0].profile).toBe('hugo');
  });
});
