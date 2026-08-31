// The tool-calling loop. Drives one model through one BenchCase: builds the
// message list (system + history + user sms), repeatedly calls the chat
// completion endpoint, executes any tool calls via the deterministic mock
// engine, feeds results back, and captures a Transcript (tool calls, final
// text, iteration count, and cumulative latency).

import type { BenchCase, Transcript, ToolCallRecord } from './case.js';
import { runTool } from './mock-engine.js';

export const MAX_ITERATIONS = 10;

/** The minimal client surface the loop needs, so a stub can satisfy it. */
export interface ChatClient {
  chat: { completions: { create: (params: any) => Promise<any> } };
}

/**
 * Run the tool-calling loop starting from a GIVEN messages array. Mutates and
 * extends that array in place (pushing assistant messages and tool results) and
 * returns both the resulting transcript and the final extended messages list,
 * so a caller can resume the conversation from where it left off. Tool calls
 * are executed through the mock engine; the only side effect is calling the
 * supplied client.
 */
export async function runLoop(
  client: ChatClient,
  modelName: string,
  messages: any[],
  tools: any[],
  mocks: BenchCase['mocks'] = {},
): Promise<{ transcript: Transcript; messages: any[] }> {
  const toolCalls: ToolCallRecord[] = [];
  let finalText = '';
  let iterations = 0;
  let latencyMs = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const t0 = Date.now();
    const resp = await client.chat.completions.create({
      model: modelName,
      messages,
      tools,
      tool_choice: 'auto',
    });
    latencyMs += Date.now() - t0;

    const msg = resp.choices[0].message;

    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      messages.push(msg);
      for (const call of msg.tool_calls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          args = { _raw: call.function.arguments };
        }
        const record: ToolCallRecord = { name: call.function.name, args };
        toolCalls.push(record);
        const result = runTool(call.function.name, args, mocks ?? {});
        try {
          const parsed = JSON.parse(result);
          if (parsed !== null && typeof parsed === 'object') {
            if ('error' in parsed) record.resultIsError = true;
            if ('nextCursor' in parsed) {
              record.resultNextCursor = (parsed as { nextCursor: string | null }).nextCursor;
            }
          }
        } catch {
          // Non-JSON tool result (e.g. a formatted time string); leave fields unset.
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result,
        });
      }
      iterations += 1;
      continue;
    }

    finalText = msg.content ?? '';
    iterations += 1;
    break;
  }

  return { transcript: { toolCalls, finalText, iterations, latencyMs }, messages };
}

/**
 * Run a single benchmark case against one model. Builds the message list
 * (system + history + user sms) and delegates to runLoop, returning just the
 * transcript. Never makes side effects beyond calling the supplied client.
 */
export async function runCase(
  client: ChatClient,
  modelName: string,
  c: BenchCase,
  sys: string,
  tools: any[],
): Promise<Transcript> {
  const messages: any[] = [{ role: 'system', content: sys }];
  for (const entry of c.history ?? []) {
    messages.push({ role: entry.role, content: entry.content });
  }
  messages.push({ role: 'user', content: c.sms });
  // Production injects screen-context as a trailing system message after the turn.
  if (c.screenContext !== undefined) {
    messages.push({ role: 'system', content: c.screenContext });
  }

  const { transcript } = await runLoop(client, modelName, messages, tools, c.mocks ?? {});
  return transcript;
}
