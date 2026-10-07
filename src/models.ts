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
    label: 'crucible tuned 9B v3.1 (frame:8289)',
    baseURL: 'http://frame:8289/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'crucible-9b-v31-q5_k_m.gguf',
    kind: 'local',
  },
  {
    // crucible v6 candidate: Nanbeige4.2-3B (looped-transformer, trust_remote_code base) QLoRA
    // on corpus-v6. Serve with the PERMISSIVE Nanbeige chat template (renders trailing
    // <screen-context> system turns inline) and reasoning off. Port 8090 by convention.
    id: 'nanbeige-v6',
    label: 'crucible v6 Nanbeige-3B (frame:8090)',
    baseURL: 'http://frame:8090/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'nanbeige-v6-q5_k_m.gguf',
    kind: 'local',
  },
  {
    // crucible v6 candidate: Ling-3.0-tiny (bailingmoe3, 7.9B-total/1.3B-active hybrid-KDA MoE)
    // QLoRA on corpus-v6. Non-ChatML <role> template + XML tool-call format — needs the Ling
    // template/parser adapter. Serve reasoning off. Port 8091 by convention.
    id: 'ling-v6',
    label: 'crucible v6 Ling-3.0-tiny (frame:8091)',
    baseURL: 'http://frame:8091/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'ling-v6-q5_k_m.gguf',
    kind: 'local',
  },
  {
    // crucible v6 ANCHOR: dense Qwen3.5-9B on corpus-v6 — same base/arch/size as production v3.1,
    // only the corpus differs. THE apples-to-apples test of the v6 corpus. Serve with the
    // permissive template + reasoning off. Port 8090 (reuses the retired nanbeige-v6 slot).
    id: 'crucible-9b-v6',
    label: 'crucible v6 anchor Qwen3.5-9B (frame:8090)',
    baseURL: 'http://frame:8090/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'crucible-9b-v6-q5_k_m.gguf',
    kind: 'local',
  },
  {
    // crucible v6.1: the anchor RETRAINED on corpus-v6.2 (v6.1 + 16 murmur8 correction golds
    // teaching mark-done->update-in-place + act-on-active-item, to recover the murmur8 regression
    // v6 had vs v3.1 while keeping the hugo gain). Serve on 8090 like the anchor.
    id: 'crucible-9b-v61',
    label: 'crucible v6.1 Qwen3.5-9B corpus-v6.2 (frame:8090)',
    baseURL: 'http://frame:8090/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'crucible-9b-v61-q5_k_m.gguf',
    kind: 'local',
  },
  {
    // crucible v7: the anchor trained on corpus-v7 (690 traces: grounded production-format clocks,
    // live tool-argument contract, 109 targeted golds, 17 real Hugo episodes). Serve on 8090.
    id: 'crucible-9b-v7',
    label: 'crucible v7 Qwen3.5-9B corpus-v7 (frame:8090)',
    baseURL: 'http://frame:8090/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'crucible-9b-v7-q5_k_m.gguf',
    kind: 'local',
  },
  {
    // crucible v7.1: corpus-v7.1 (735 traces) — every clock carries the "Next 7 days" table the
    // production clocks now send, 48 weekend-clock weekday golds, the double-clock and
    // unprepared-real-trace defects fixed. Serve on 8090 (production v7 stays on 8289).
    id: 'crucible-9b-v71',
    label: 'crucible v7.1 Qwen3.5-9B corpus-v7.1 (frame:8090)',
    baseURL: 'http://frame:8090/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'crucible-9b-v71-q5_k_m.gguf',
    kind: 'local',
  },
  {
    // crucible v7.2: corpus-v7.2 packed rows (production prompts, tools, wrappers and result shapes;
    // final-completion loss). Served on 8090 with the live crucible9b chat template.
    id: 'crucible-9b-v72',
    label: 'crucible v7.2 Qwen3.5-9B corpus-v7.2 (frame:8090)',
    baseURL: 'http://frame:8090/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'crucible-9b-v72-q5_k_m.gguf',
    kind: 'local',
  },
  {
    // Production v7 on the B580 (promoted 2026-09-26), for same-run comparisons against v7.1.
    id: 'crucible-9b-v7-prod',
    label: 'crucible v7 production (frame:8289)',
    baseURL: 'http://frame:8289/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'crucible-9b-v7-q5_k_m.gguf',
    kind: 'local',
  },
  {
    // crucible v6 candidate: Ornith-1.5-9B (dense qwen35, MIT). Same recipe/serve as the anchor.
    id: 'ornith-v6',
    label: 'crucible v6 Ornith-1.5-9B (frame:8096)',
    baseURL: 'http://frame:8096/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'ornith-v6-q5_k_m.gguf',
    kind: 'local',
  },
  {
    // crucible v6 candidate: LFM2.5-8B-A1B (lfm2_moe, 32-expert/4-active). llama.cpp lfm2moe +
    // <|tool_call_start|> parser (bug #23838 fixed in frame's build). Serve reasoning off.
    id: 'lfm2-v6',
    label: 'crucible v6 LFM2.5-8B-A1B (frame:8097)',
    baseURL: 'http://frame:8097/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'lfm2-v6-q5_k_m.gguf',
    kind: 'local',
  },
  // B580 small-model bake-off (2026-10-03): base models zero-shot, each hand-served on the B580 with
  // the production crucible9b flags (their own GGUF chat templates), one at a time, ports 8290-8293.
  {
    id: 'b580-qwen35-4b',
    // bartowski's quant: unsloth's Qwen3.5-4B Q5_K_M decodes at 14 tokens per second on the B580 (this one at 67).
    label: 'Qwen3.5-4B Q5_K_M (bartowski) base on the B580 (frame:8290)',
    baseURL: 'http://frame:8290/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'Qwen_Qwen3.5-4B-Q5_K_M.gguf',
    kind: 'local',
  },
  {
    id: 'b580-lfm25-2.6b',
    label: 'LFM2.5-2.6B Q8_0 base on the B580 (frame:8291)',
    baseURL: 'http://frame:8291/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'LFM2.5-2.6B-Q8_0.gguf',
    kind: 'local',
  },
  {
    id: 'b580-ling3-tiny',
    label: 'Ling-3.0-tiny Q4_K_M base on the B580 (frame:8292)',
    baseURL: 'http://frame:8292/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'Ling-3.0-tiny-Q4_K_M.gguf',
    kind: 'local',
  },
  {
    // The production v7 GGUF and chat template, served the same way as the candidates for a same-session baseline.
    id: 'b580-crucible-9b-v7',
    label: 'crucible v7 Q5_K_M on the B580, bake-off baseline (frame:8293)',
    baseURL: 'http://frame:8293/v1',
    apiKeyEnv: 'FRAME_API_KEY',
    model: 'crucible-9b-v7-q5_k_m.gguf',
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
