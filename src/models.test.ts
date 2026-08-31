import { describe, it, expect } from 'vitest';
import { MODELS, getClient, slugifyModelFile, ephemeralModel } from './models.js';

describe('slugifyModelFile', () => {
  it('lowercases, strips .gguf, and collapses non-alphanumerics to single dashes', () => {
    expect(slugifyModelFile('Qwen-AgentWorld-35B-A3B-UD-Q4_K_M.gguf')).toBe(
      'qwen-agentworld-35b-a3b-ud-q4-k-m',
    );
  });

  it('handles a plain filename and trims leading/trailing dashes', () => {
    expect(slugifyModelFile('m.gguf')).toBe('m');
    expect(slugifyModelFile('__Foo  Bar!!.gguf')).toBe('foo-bar');
  });
});

describe('ephemeralModel', () => {
  it('derives the id from the gguf filename slug', () => {
    const m = ephemeralModel('http://frame:8086/v1', 'Qwen-AgentWorld-35B-A3B-UD-Q4_K_M.gguf');
    expect(m.id).toBe('qwen-agentworld-35b-a3b-ud-q4-k-m');
    expect(m.label).toBe('candidate (Qwen-AgentWorld-35B-A3B-UD-Q4_K_M.gguf)');
    expect(m.model).toBe('Qwen-AgentWorld-35B-A3B-UD-Q4_K_M.gguf');
    expect(m.kind).toBe('local');
    expect(m.apiKeyEnv).toBe('FRAME_API_KEY');
  });
});

describe('MODELS registry', () => {
  it('has a haiku entry pointing at OpenRouter with the claude-haiku-4.5 model', () => {
    const haiku = MODELS.find((m) => m.id === 'haiku');
    expect(haiku).toBeDefined();
    expect(haiku!.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(haiku!.model).toBe('anthropic/claude-haiku-4.5');
  });

  it('has at least 3 entries with unique ids', () => {
    expect(MODELS.length).toBeGreaterThanOrEqual(3);
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('getClient', () => {
  it('returns an OpenAI client whose chat.completions.create is a function', () => {
    const client = getClient(MODELS.find((m) => m.id === 'haiku')!);
    expect(typeof client.chat.completions.create).toBe('function');
  });
});
