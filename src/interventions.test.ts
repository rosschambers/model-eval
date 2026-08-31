import { describe, it, expect } from 'vitest';
import {
  withStructuralGuard,
  withVerificationPass,
  CORRECTIVE_MESSAGE,
  VERIFIER_SYSTEM,
} from './interventions.js';
import type { ChatClient } from './loop.js';
import type { BenchCase } from './case.js';

/**
 * Stub ChatClient returning scripted responses one per call. If the script runs
 * out, the last response repeats. Snapshots the messages array of every call
 * (shallow copy) so per-call inspection is not clobbered by later mutation.
 */
function stubClient(responses: any[]): { client: ChatClient; calls: any[] } {
  const calls: any[] = [];
  let index = 0;
  const client: ChatClient = {
    chat: {
      completions: {
        create: async (params: any) => {
          calls.push({ ...params, messages: [...params.messages] });
          const response = responses[Math.min(index, responses.length - 1)];
          index += 1;
          return response;
        },
      },
    },
  };
  return { client, calls };
}

function baseCase(overrides: Partial<BenchCase> = {}): BenchCase {
  return {
    id: 'test-case',
    capability: 'test',
    sms: 'move my 3pm to 4pm',
    expect: [],
    ...overrides,
  };
}

function toolCallResponse(name: string, args: Record<string, unknown>): any {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  };
}

function finalResponse(content: string): any {
  return { choices: [{ message: { role: 'assistant', content } }] };
}

const SYS = 'You are a helpful assistant.';
const TOOLS: any[] = [];

describe('withStructuralGuard', () => {
  it('does nothing extra when phase 1 makes a mutating call (not fabrication)', async () => {
    const { client, calls } = stubClient([
      toolCallResponse('update', { type: 'calendar_event', eventId: 'abc' }),
      finalResponse('Done. Moved it to 4pm.'),
    ]);

    const transcript = await withStructuralGuard()(client, 'model-x', baseCase(), SYS, TOOLS);

    // Only the two phase-1 calls — no corrective second phase.
    expect(calls.length).toBe(2);
    expect(transcript.toolCalls.map((t) => t.name)).toEqual(['update']);
    expect(transcript.finalText).toBe('Done. Moved it to 4pm.');
    // No call's message list should contain the corrective text.
    const sawCorrective = calls.some((call) =>
      call.messages.some((m: any) => m.content === CORRECTIVE_MESSAGE),
    );
    expect(sawCorrective).toBe(false);
  });

  it('injects exactly one corrective message and runs a second phase on fabrication', async () => {
    const { client, calls } = stubClient([
      // Phase 1: claims completion with no mutating call → fabrication.
      finalResponse('Done. Moved it to 4pm.'),
      // Phase 2: now actually mutates, then reports.
      toolCallResponse('update', { type: 'calendar_event', eventId: 'abc' }),
      finalResponse('Updated it now.'),
    ]);

    const transcript = await withStructuralGuard()(client, 'model-x', baseCase(), SYS, TOOLS);

    // 1 phase-1 call + 2 phase-2 calls.
    expect(calls.length).toBe(3);

    // The phase-2 first call (index 1) must carry the corrective user message.
    const phase2First = calls[1];
    const correctiveCount = phase2First.messages.filter(
      (m: any) => m.role === 'user' && m.content === CORRECTIVE_MESSAGE,
    ).length;
    expect(correctiveCount).toBe(1);

    // Combined transcript carries the second-phase tool call and final text.
    expect(transcript.toolCalls.map((t) => t.name)).toEqual(['update']);
    expect(transcript.finalText).toBe('Updated it now.');
    expect(transcript.iterations).toBe(3);
  });
});

/**
 * Stub ChatClient that returns different scripts for the phase-1 conversation
 * versus the verifier conversation, distinguished by the system message content.
 * Records every call so per-phase invocation counts can be asserted.
 */
function phasedStubClient(
  phase1Responses: any[],
  verifierResponses: any[],
): { client: ChatClient; calls: any[] } {
  const calls: any[] = [];
  let phase1Index = 0;
  let verifierIndex = 0;
  const client: ChatClient = {
    chat: {
      completions: {
        create: async (params: any) => {
          calls.push({ ...params, messages: [...params.messages] });
          const isVerifier = params.messages[0]?.content === VERIFIER_SYSTEM;
          if (isVerifier) {
            const response = verifierResponses[Math.min(verifierIndex, verifierResponses.length - 1)];
            verifierIndex += 1;
            return response;
          }
          const response = phase1Responses[Math.min(phase1Index, phase1Responses.length - 1)];
          phase1Index += 1;
          return response;
        },
      },
    },
  };
  return { client, calls };
}

describe('withVerificationPass', () => {
  it('runs a verifier pass that can call a tool, and combines transcripts', async () => {
    const { client, calls } = phasedStubClient(
      // Phase 1: claims completion with no mutating call.
      [finalResponse('Done. Added milk to your list.')],
      // Verifier: performs the missing action, then writes the corrected reply.
      [
        toolCallResponse('create', { type: 'task', title: 'milk' }),
        finalResponse('Added milk to your list. Confirmed.'),
      ],
    );

    const transcript = await withVerificationPass()(client, 'model-x', baseCase(), SYS, TOOLS);

    // Phase 1 (1 call) + verifier (2 calls).
    expect(calls.length).toBe(3);
    // Combined tool calls include the verifier's create call.
    expect(transcript.toolCalls.map((t) => t.name)).toEqual(['create']);
    // Final text is the verifier's reply.
    expect(transcript.finalText).toBe('Added milk to your list. Confirmed.');
    // Verifier conversation starts from a fresh system = VERIFIER_SYSTEM.
    const verifierCalls = calls.filter((call) => call.messages[0]?.content === VERIFIER_SYSTEM);
    expect(verifierCalls.length).toBe(2);
    // The verifier's first user message summarises the original SMS.
    const verifierUser = verifierCalls[0].messages.find((m: any) => m.role === 'user');
    expect(verifierUser.content).toContain('move my 3pm to 4pm');
  });

  it('makes exactly one verifier pass and returns the verifier text when no tools are needed', async () => {
    const { client, calls } = phasedStubClient(
      [finalResponse('Your 3pm is now at 4pm.')],
      [finalResponse('Your 3pm is now at 4pm.')],
    );

    const transcript = await withVerificationPass()(client, 'model-x', baseCase(), SYS, TOOLS);

    // Phase 1 (1 call) + exactly one verifier call.
    const verifierCalls = calls.filter((call) => call.messages[0]?.content === VERIFIER_SYSTEM);
    expect(verifierCalls.length).toBe(1);
    expect(transcript.finalText).toBe('Your 3pm is now at 4pm.');
    expect(transcript.toolCalls).toEqual([]);
  });

  it('falls back to the phase-1 final text when the verifier returns empty', async () => {
    const { client } = phasedStubClient(
      [finalResponse('Phase one reply.')],
      [finalResponse('')],
    );

    const transcript = await withVerificationPass()(client, 'model-x', baseCase(), SYS, TOOLS);

    expect(transcript.finalText).toBe('Phase one reply.');
  });
});
