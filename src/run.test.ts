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

  it("passes each case's sms through the profile's buildUserMessage before running it", async () => {
    const seen: string[] = [];
    const capturingRunner = async (_client: any, _model: string, c: any) => {
      seen.push(c.sms);
      return { toolCalls: [], finalText: 'Done.', iterations: 1, latencyMs: 1 };
    };
    const profile = { ...hugoProfile, buildUserMessage: (sms: string) => `${sms} [ctx]` };

    await runOneProfile(stubClient as any, 'stub-model', profile, {
      cases: hugoProfile.cases.slice(0, 1),
      repeat: 1,
      runner: capturingRunner as any,
    });

    expect(seen).toEqual([`${hugoProfile.cases[0].sms} [ctx]`]);
  });

  it("wraps history USER turns with buildUserMessage too, as production memory stores them", async () => {
    // n8n's Postgres chat memory stores the agent's full input text, so every earlier Hugo user
    // turn carries its REQUEST CONTEXT (hugo_chat_history, verified 2026-09-27).
    const seen: any[] = [];
    const capturingRunner = async (_client: any, _model: string, c: any) => {
      seen.push(c.history);
      return { toolCalls: [], finalText: 'Done.', iterations: 1, latencyMs: 1 };
    };
    const profile = { ...hugoProfile, buildUserMessage: (sms: string) => `${sms} [ctx]` };
    const withHistory = {
      ...hugoProfile.cases[0],
      history: [
        { role: 'user' as const, content: 'add eggs to my groceries list' },
        { role: 'assistant' as const, content: 'Added eggs to your groceries list.' },
      ],
    };

    await runOneProfile(stubClient as any, 'stub-model', profile, { cases: [withHistory], repeat: 1, runner: capturingRunner as any });

    expect(seen[0]).toEqual([
      { role: 'user', content: 'add eggs to my groceries list [ctx]' },
      { role: 'assistant', content: 'Added eggs to your groceries list.' },
    ]);
  });

  it('leaves history untouched for a profile without buildUserMessage (the portal stores plain user turns)', async () => {
    const seen: any[] = [];
    const capturingRunner = async (_client: any, _model: string, c: any) => {
      seen.push(c.history);
      return { toolCalls: [], finalText: 'Done.', iterations: 1, latencyMs: 1 };
    };
    const profile = { ...hugoProfile, buildUserMessage: undefined };
    const history = [{ role: 'user' as const, content: 'earlier' }];

    await runOneProfile(stubClient as any, 'stub-model', profile, {
      cases: [{ ...hugoProfile.cases[0], history }],
      repeat: 1,
      runner: capturingRunner as any,
    });

    expect(seen[0]).toEqual(history);
  });

  it("attaches the profile's trailing user-context to every case it runs", async () => {
    const seen: (string | undefined)[] = [];
    const capturingRunner = async (_client: any, _model: string, c: any) => {
      seen.push(c.userContext);
      return { toolCalls: [], finalText: 'Done.', iterations: 1, latencyMs: 1 };
    };
    const profile = { ...hugoProfile, buildTrailingUserContext: () => '<user-context>now</user-context>' };

    await runOneProfile(stubClient as any, 'stub-model', profile, {
      cases: hugoProfile.cases.slice(0, 2),
      repeat: 1,
      runner: capturingRunner as any,
    });

    expect(seen).toEqual(['<user-context>now</user-context>', '<user-context>now</user-context>']);
  });
});
