# model-eval

Benchmarks local GGUF models against real agent tool-calling profiles via SSH and llama-server.

You have a fine-tuned 4B model and want to know if it can replace the 35B running in production.
Point this CLI at a HuggingFace repo, and it serves the GGUF on your inference box over SSH,
runs it through the same tool-calling scenarios your agents handle in production, and tells you
exactly where it passes and where it breaks.

## What makes it interesting

**Assertion-based case sets.** Each test case carries typed assertions — `callOrder` (did it
call tools in the right sequence?), `argEquals` (did it pass the right calendar ID?),
`noFabrication` (did it claim success without actually calling anything?). Not vibes. Code-checked.

**Injected-effects architecture.** The mock engine returns deterministic responses shaped like
real API payloads — pagination cursors, error payloads, empty result sets — so 171 tests run
offline in ~1 second with zero network calls.

**Durable JSONL baselines with cached A/B.** A registry tracks every run. Once you benchmark
your production model, later candidates reuse the cached baseline (`--baseline cached:qwen-agentic`)
so you only serve one model at a time. Runs stay comparable across weeks.

**Real results.** From a three-candidate sweep against a 35B-A3B production baseline:

```
hugo profile (43 cases)
Model                      Tool-correctness   Case pass   Latency p95
qwen-agentic (baseline)    88.4%              81.4%       8.2s
Qwythos-9B                 87.7%              79.1%       34.6s
gemma4-v2-12B              81.3%              54.8%       60.6s
Qwen-AgentWorld-35B-A3B    63.2%              55.8%       105s

murmur8 profile (19 cases)
Model                      Tool-correctness   Case pass   Latency p95
qwen-agentic (baseline)    76.1%              52.6%       12.5s
Qwythos-9B                 74.6%              47.4%       21.3s
```

The 9B hit parity on tool-correctness but couldn't beat the MoE on latency. The "agentic-branded"
35B scored 18% on murmur8 and took 167 seconds per turn.

## How it works

```
model-eval run <hf-repo> [--profile hugo,murmur8] [--baseline cached:<id>] [--keep]
```

1. Resolves a GGUF from HuggingFace (auto-picks Q4_K_M; `HF_TOKEN` for gated repos).
2. SSHs into the inference host, downloads the model, starts an ad-hoc llama-server.
3. Runs every case in the selected profiles — tool-calling loop, mock responses, assertion scoring.
4. Writes `raw.jsonl` (full transcripts), `scores.json` (per-case pass/fail), `summary.json`
   (aggregates), and a `judging-bundle.md` for a separate reply-quality pass.
5. Tears down the server (unless `--keep`).

## Tech stack

TypeScript, Node, Vitest. No frameworks. The profiles mirror two real agents (an SMS assistant
and an in-app assistant) with their production system prompts and tool surfaces.

## Requirements

- An SSH-accessible host with `llama-server` installed and `/var/lib/llama-server/models/` writable.
  Default target: `ssh frame`. Override with `FRAME_SSH_HOST`.
- `HUGO_WORKFLOW_PATH` — path to the n8n workflow source containing the Hugo system prompt.
- `MURMUR8_APPSETTINGS_PATH` — path to an appsettings.json with the murmur8 agent prompt.
- `HF_TOKEN` for gated HuggingFace repos. `FRAME_API_KEY` for non-default llama-server auth.
- The test suite needs none of the above — fixtures are self-contained.

## Run

```bash
npm install
npm test              # 171 tests, ~1 second, no network
npx tsc --noEmit      # type-check
```

## License

[MIT](LICENSE) — Copyright (c) 2026 Ross Chambers.
