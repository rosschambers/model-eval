import OpenAI from 'openai';

export interface ModelConfig {
  id: string;
  label: string;
  baseURL: string;
  apiKeyEnv: string;
  model: string;
  kind: 'cloud' | 'local';
}

export const MODELS: ModelConfig[] = [
  {
    id: 'haiku',
    label: 'Claude Haiku 4.5',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    model: 'anthropic/claude-haiku-4.5',
    kind: 'cloud',
  },
  {
    id: 'qwen-agentic',
    label: 'qwen3.6-35b-a3b-heretic-mtp (frame:8081)',
    baseURL: 'http://frame:8081/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'qwen3.6-35b-a3b-heretic-mtp-Q5_K_M.gguf',
    kind: 'local',
  },
  {
    id: 'gemma4',
    label: 'gemma-4-12b-it (frame:8083)',
    baseURL: 'http://frame:8083/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'gemma-4-12b-it-uncensored-Q4_K_M.gguf',
    kind: 'local',
  },
  {
    id: 'qwen3-30b-instruct',
    label: 'Qwen3-30B-A3B-Instruct-2507 (frame:8086)',
    baseURL: 'http://frame:8086/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'qwen3-30b-a3b-instruct-2507-Q4_K_M.gguf',
    kind: 'local',
  },
  {
    id: 'qwen3-4b-instruct',
    label: 'Qwen3-4B-Instruct-2507 (frame:8087)',
    baseURL: 'http://frame:8087/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'qwen3-4b-instruct-2507-Q4_K_M.gguf',
    kind: 'local',
  },
  {
    id: 'crucible-4b',
    label: 'crucible tuned 4B v3.1 (frame:8088)',
    baseURL: 'http://frame:8088/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'crucible-4b-v31-q5_k_m.gguf',
    kind: 'local',
  },
  {
    id: 'crucible-9b',
    label: 'crucible tuned 9B v3.1 (frame:8089)',
    baseURL: 'http://frame:8089/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'crucible-9b-v31-q5_k_m.gguf',
    kind: 'local',
  },
];

export function getClient(m: ModelConfig): OpenAI {
  return new OpenAI({
    baseURL: m.baseURL,
    apiKey: process.env[m.apiKeyEnv] ?? 'sk-local',
  });
}

/**
 * Derive a stable, comparable model id from a GGUF filename: lowercase the
 * basename, strip a trailing `.gguf`, collapse any run of non-`[a-z0-9]` chars
 * into a single `-`, and trim leading/trailing dashes.
 */
export function slugifyModelFile(file: string): string {
  const basename = file.split('/').pop() ?? file;
  return basename
    .toLowerCase()
    .replace(/\.gguf$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Build a ModelConfig for an ad-hoc candidate served on frame at `baseURL`. */
export function ephemeralModel(baseURL: string, servedModelName: string): ModelConfig {
  return {
    id: slugifyModelFile(servedModelName),
    label: `candidate (${servedModelName})`,
    baseURL,
    apiKeyEnv: 'FRAME_API_KEY',
    model: servedModelName,
    kind: 'local',
  };
}

/** Look up a registered model by id (e.g. the `haiku` baseline). Throws if absent. */
export function findModel(id: string): ModelConfig {
  const model = MODELS.find((m) => m.id === id);
  if (!model) throw new Error(`unknown model: ${id}`);
  return model;
}
