// Every memory-follow-up case must replay its earlier turn the way production memory does: the
// user turn, the tool calls the agent made with their results, then the final reply. A follow-up
// ("move that", "add milk to that list too") only makes sense when the ids it needs are in an
// earlier tool result, exactly as they are in hugo_chat_history and murmur8 ConversationMessages.

import { describe, it, expect } from 'vitest';
import { CASES } from './cases.js';
import { MURMUR8_CASES } from './cases-murmur8.js';
import { PROBE_CASES } from './cases-probe.js';
import { replayHugoHistory } from './history.js';
import { getToolDefs } from './tools.js';
import { getMurmur8ToolDefs } from './tools-murmur8.js';
import type { BenchCase, HistoryMessage } from './case.js';

interface SurfaceCases {
  label: string;
  cases: BenchCase[];
  toolNames: string[];
  // Hugo memory replays a bounded window; the portal replays the whole conversation.
  hugoWindow: boolean;
}

function toolNames(tools: ReturnType<typeof getToolDefs>): string[] {
  return tools.map((tool) => (tool as { function: { name: string } }).function.name);
}

const HUGO_TOOLS = toolNames(getToolDefs());
const MURMUR8_TOOLS = toolNames(getMurmur8ToolDefs());

const SURFACES: SurfaceCases[] = [
  { label: 'hugo', cases: CASES, toolNames: HUGO_TOOLS, hugoWindow: true },
  { label: 'murmur8', cases: MURMUR8_CASES, toolNames: MURMUR8_TOOLS, hugoWindow: false },
  { label: 'hugo-probe', cases: PROBE_CASES, toolNames: HUGO_TOOLS, hugoWindow: true },
  { label: 'murmur8-probe', cases: PROBE_CASES, toolNames: MURMUR8_TOOLS, hugoWindow: false },
];

/** Every string value under a key ending in "Id" (taskListId, calendarId, eventId, reminderId). */
function idValues(callArguments: Record<string, unknown>): string[] {
  return Object.entries(callArguments)
    .filter(([key, value]) => key.endsWith('Id') && typeof value === 'string')
    .map(([, value]) => value as string);
}

function toolResults(history: HistoryMessage[]): string[] {
  const results: string[] = [];
  for (const message of history) {
    if (message.role === 'tool') results.push(message.content);
  }
  return results;
}

describe('memory-followup cases replay the production history shape', () => {
  for (const surface of SURFACES) {
    const memoryCases = surface.cases.filter((benchCase) => benchCase.capability === 'memory-followup');

    it(`${surface.label} has memory-followup cases`, () => {
      expect(memoryCases.length).toBeGreaterThan(0);
    });

    for (const benchCase of memoryCases) {
      describe(`${surface.label} ${benchCase.id}`, () => {
        const history = benchCase.history ?? [];

        it('opens on the user turn and closes on a plain final reply', () => {
          expect(history[0]?.role).toBe('user');
          const last = history[history.length - 1];
          expect(last?.role).toBe('assistant');
          expect(last && 'toolCalls' in last ? last.toolCalls : undefined).toBeUndefined();
          expect(last?.role === 'assistant' ? last.content : '').not.toBe('');
        });

        it('made at least one tool call in the earlier turn', () => {
          expect(history.some((message) => message.role === 'assistant' && message.toolCalls !== undefined)).toBe(true);
        });

        it('answers every tool call, in order, right after the call, with a JSON result', () => {
          for (let index = 0; index < history.length; index++) {
            const message = history[index];
            if (message.role !== 'assistant' || message.toolCalls === undefined) continue;
            message.toolCalls.forEach((call, offset) => {
              const result = history[index + 1 + offset];
              expect(result).toMatchObject({ role: 'tool', toolCallId: call.id, name: call.name });
              expect(() => JSON.parse(result.role === 'tool' ? result.content : '')).not.toThrow();
            });
          }
        });

        it('only calls tools the surface actually offers', () => {
          for (const message of history) {
            if (message.role !== 'assistant' || message.toolCalls === undefined) continue;
            for (const call of message.toolCalls) expect(surface.toolNames).toContain(call.name);
          }
        });

        it('takes every id a history tool call uses from an EARLIER tool result', () => {
          const seenResults: string[] = [];
          for (const message of history) {
            if (message.role === 'tool') seenResults.push(message.content);
            if (message.role !== 'assistant' || message.toolCalls === undefined) continue;
            for (const call of message.toolCalls) {
              for (const id of idValues(call.arguments)) {
                expect(seenResults.some((result) => result.includes(`"${id}"`)), `${call.name} ${id}`).toBe(true);
              }
            }
          }
        });

        it('carries every id the assertions expect in a history tool result', () => {
          const results = toolResults(history);
          for (const assertion of benchCase.expect) {
            if (assertion.kind !== 'argEquals' || !assertion.path.endsWith('Id') || typeof assertion.value !== 'string') continue;
            const id = assertion.value;
            expect(results.some((result) => result.includes(`"${id}"`)), `${assertion.path} ${id}`).toBe(true);
          }
        });

        if (surface.hugoWindow) {
          it('fits whole inside the n8n memory window, so production would replay all of it', () => {
            const replayed = replayHugoHistory(history);
            expect(replayed[0]).toMatchObject({ role: 'user' });
            const storedCount = history.reduce((count, message) => {
              if (message.role === 'assistant' && message.toolCalls !== undefined) return count + message.toolCalls.length;
              if (message.role === 'tool') return count + 1;
              return count + 1;
            }, 0);
            expect(replayed).toHaveLength(storedCount);
          });
        }
      });
    }
  }
});
