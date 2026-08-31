import { describe, it, expect } from 'vitest';
import { getMurmur8ToolDefs } from './tools-murmur8.js';

describe('getMurmur8ToolDefs', () => {
  it('exposes the core Murmur8 MCP tools', () => {
    const names = getMurmur8ToolDefs().map((t) => t.function.name);
    expect(names).toContain('create');
    expect(names).toContain('list');
    expect(names).toContain('update');
  });

  it('exposes the read-only parse_date_time code tool the real agent now offers', () => {
    const names = getMurmur8ToolDefs().map((t) => t.function.name);
    expect(names).toContain('parse_date_time');
  });

  it('does NOT expose Hugo-only helper names (Parse_Date_Time / Convert_Time)', () => {
    const names = getMurmur8ToolDefs().map((t) => t.function.name);
    expect(names).not.toContain('Parse_Date_Time');
    expect(names).not.toContain('Convert_Time');
  });

  it('parse_date_time requires localDateTime and allows optional timeZone', () => {
    const tool = getMurmur8ToolDefs().find((t) => t.function.name === 'parse_date_time');
    expect(tool).toBeDefined();
    const params = tool!.function.parameters as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(params.required).toEqual(['localDateTime']);
    expect(params.properties).toHaveProperty('timeZone');
  });
});
