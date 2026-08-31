import { describe, it, expect } from 'vitest';
import { getToolDefs } from './tools.js';

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

  it('has length equal to fixture count plus two (18)', () => {
    expect(getToolDefs().length).toBe(18);
  });
});
