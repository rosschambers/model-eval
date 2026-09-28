import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import capturedTools from '../fixtures/hugo-n8n-tools.json' with { type: 'json' };

// Hugo's tool array is the `tools` of a REAL n8n 2.14.2 request from the live `Domain: Murmur8`
// workflow (captured 2026-09-28 at the model's HTTP boundary; fixtures/hugo-n8n-tools.json, verbatim).
// n8n sends its two code tools first (Parse_Date_Time, Convert_Time), then the 18 Murmur8 MCP tools in
// McpToolFactory order; every function carries `strict: false`, and every schema has been round-tripped
// through Zod (`additionalProperties: false`, `$schema` last, keyword order changed). The code tools'
// schemas are generated from the node's JSON example, so Parse_Date_Time exposes only `localDateTime`
// and Convert_Time's `utcIso` has no description. Re-capture after any n8n or murmur8 tool change;
// fixtures/tools-fixture.json (the murmur8 tools/list snapshot) still feeds the portal profile.

export function getToolDefs(): ChatCompletionTool[] {
  return structuredClone(capturedTools) as ChatCompletionTool[];
}
