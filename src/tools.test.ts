import { describe, it, expect } from 'vitest';
import { getToolDefs } from './tools.js';
import fixture from '../fixtures/tools-fixture.json' with { type: 'json' };
import { readFileSync } from 'node:fs';

// The tools array of a real n8n 2.14.2 request from the live `Domain: Murmur8` workflow (captured
// 2026-09-28): n8n lists its two code tools first, adds `strict: false`, and round-trips every schema
// through Zod. The Hugo profile must send exactly this.
const N8N_CAPTURE_TEXT = readFileSync(new URL('../fixtures/hugo-n8n-tools.json', import.meta.url), 'utf8');

describe('getToolDefs', () => {
  it('includes the core MCP fixture tools', () => {
    const names = getToolDefs().map((t) => t.function.name);
    expect(names).toContain('create');
    expect(names).toContain('list');
    expect(names).toContain('update');
    expect(names).toContain('delete');
    expect(names).toContain('search');
  });

  it('includes the two code tools exactly', () => {
    const names = getToolDefs().map((t) => t.function.name);
    expect(names).toContain('Convert_Time');
    expect(names).toContain('Parse_Date_Time');
  });

  it('returns well-formed function tools', () => {
    for (const tool of getToolDefs()) {
      expect(tool.type).toBe('function');
      expect(typeof tool.function.name).toBe('string');
      expect(tool.function.name.length).toBeGreaterThan(0);
      expect(typeof tool.function.parameters).toBe('object');
      expect(tool.function.parameters).not.toBeNull();
    }
  });

  it('has length equal to fixture count plus the two Hugo code tools', () => {
    expect(getToolDefs().length).toBe(fixture.tools.length + 2);
  });

  it('exposes the live update schema, including reminder rescheduling and revisions', () => {
    const update = getToolDefs().find((t) => t.function.name === 'update')!;
    const properties = Object.keys((update.function.parameters as any).properties);
    expect(properties).toContain('remindAt');
    expect(properties).toContain('revision');
  });

  it('is the captured n8n tools array exactly: order, keys and key order', () => {
    expect(JSON.stringify(getToolDefs())).toBe(JSON.stringify(JSON.parse(N8N_CAPTURE_TEXT)));
    expect(getToolDefs().map((t) => t.function.name).slice(0, 2)).toEqual(['Parse_Date_Time', 'Convert_Time']);
  });

  it('exposes Parse_Date_Time with only localDateTime, as n8n generates it from the node example', () => {
    const parse = getToolDefs().find((t) => t.function.name === 'Parse_Date_Time')!;
    expect(parse.function.parameters).toEqual({
      type: 'object', properties: { localDateTime: { type: 'string' } }, required: ['localDateTime'],
      additionalProperties: false, $schema: 'http://json-schema.org/draft-07/schema#',
    });
  });

  it('carries the same 18 MCP tools, in McpToolFactory order, as the tools/list fixture', () => {
    expect(getToolDefs().map((t) => t.function.name).slice(2)).toEqual(fixture.tools.map((tool) => tool.name));
  });
});
