import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import fixture from '../fixtures/tools-fixture.json' with { type: 'json' };

interface FixtureTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const CODE_TOOLS: FixtureTool[] = [
  {
    name: 'Convert_Time',
    description:
      'Convert a UTC ISO 8601 timestamp to the user\'s local time. Input is a JSON object with a "utcIso" property containing the timestamp string (e.g. "2026-04-20T17:00:00Z"). Returns a formatted local time string like "Mon Apr 20, 1:00 PM".',
    inputSchema: {
      type: 'object',
      properties: {
        utcIso: {
          type: 'string',
          description: 'UTC ISO 8601 timestamp, e.g. 2026-04-20T17:00:00Z',
        },
      },
      required: ['utcIso'],
    },
  },
  {
    name: 'Parse_Date_Time',
    description:
      'Convert a LOCAL wall-clock date-time into the exact forms the Murmur8 tools need, so you never do timezone math yourself. Input JSON: { "localDateTime": "2026-04-22T15:00:00" } -- the local time you worked out from the user request and the current time context (no Z, no offset). Optional "timeZone" overrides the user default. Returns JSON { "localNaive": "2026-04-22T15:00:00", "utc": "2026-04-22T19:00:00Z", "timeZone": "America/Detroit" }. Use localNaive + timeZone for calendar_event startTime/endTime. Use utc for reminder remindAt.',
    inputSchema: {
      type: 'object',
      properties: {
        localDateTime: {
          type: 'string',
          description:
            'Local wall-clock date-time, no Z/offset, e.g. 2026-04-22T15:00:00',
        },
        timeZone: {
          type: 'string',
          description: 'Optional IANA timezone override',
        },
      },
      required: ['localDateTime'],
    },
  },
];

export function getToolDefs(): ChatCompletionTool[] {
  const fixtureTools = fixture.tools as FixtureTool[];
  return [...fixtureTools, ...CODE_TOOLS].map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}
