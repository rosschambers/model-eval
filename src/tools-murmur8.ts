// Tool surface for the murmur8 in-app agent. It uses the SAME Murmur8 MCP tools
// as Hugo (from tools-fixture.json), plus the read-only `parse_date_time` code
// tool that the real in-app agent now exposes (src/Murmur8.Application/AI/Tools/
// ParseDateTimeTool.cs). The name/description/schema mirror that tool verbatim so
// the benchmark faithfully represents what the production agent is offered.

import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import fixture from '../fixtures/tools-fixture.json' with { type: 'json' };

interface FixtureTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Mirrors the real ParseDateTimeTool (Name / Description / ParameterSchema).
const MURMUR8_CODE_TOOLS: FixtureTool[] = [
  {
    name: 'parse_date_time',
    description:
      'Convert a LOCAL wall-clock date-time into { localNaive, utc, timeZone }. ' +
      'Use utc for reminder remindAt values, and localNaive + timeZone for calendar event start/end times. ' +
      'Never do timezone or UTC-offset arithmetic yourself — always call this tool to resolve any user-stated time. ' +
      'localDateTime must have no trailing Z and no offset (e.g. 2026-04-22T15:00:00). ' +
      "timeZone is optional; when omitted the user's saved timezone is used.",
    inputSchema: {
      type: 'object',
      properties: {
        localDateTime: {
          type: 'string',
          description:
            'Local wall-clock date-time with no Z and no offset, e.g. 2026-04-22T15:00:00.',
        },
        timeZone: {
          type: 'string',
          description:
            "Optional IANA timezone id, e.g. America/New_York. Defaults to the user's saved timezone.",
        },
      },
      required: ['localDateTime'],
      additionalProperties: false,
    },
  },
];

export function getMurmur8ToolDefs(): ChatCompletionTool[] {
  const fixtureTools = fixture.tools as FixtureTool[];
  return [...fixtureTools, ...MURMUR8_CODE_TOOLS].map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}
