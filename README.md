# model-eval

A reusable, multi-agent local-model evaluation CLI. One command takes a HuggingFace model repo,
serves the GGUF on a remote box you point it at via an ad-hoc `llama-server` over SSH, benchmarks
it across **both** agent surfaces — **Hugo** (the `Domain: Murmur8` n8n SMS agent) and **murmur8**
(the in-app agent) — and emits objective evaluation data. The judgment ("is this model good enough,
which one") is a separate reply-quality pass, not the CLI's job.

## The `frame` host — what it is and how to point elsewhere

Throughout this repo, `frame` is the default name of the inference box: the author's homelab GPU
machine, reachable as `ssh frame` on a private network. Nothing about the harness depends on that
specific machine — it only needs **any host** that:

1. accepts passwordless SSH (`ssh <host>` works non-interactively),
2. has `llama-server` (from llama.cpp) and `curl` on its `PATH`,
3. can write GGUFs to `/var/lib/llama-server/models/` (the `MODELS_DIR` constant in
   `src/frame.ts`).

To use your own box, set `FRAME_SSH_HOST=<your-host>` in the environment — it overrides the SSH
target for ad-hoc serving and the base URL the benchmark talks to. The pre-registered baseline
models in `src/models.ts` hardcode `http://frame:<port>/v1` because they are long-running instances
on the author's machine; edit or add entries there (see
[Adding a baseline model](#adding-a-baseline-model)) to point at yours, or run with
`--baseline none`. `FRAME_API_KEY` is the API key sent to those local endpoints and falls back to a
dummy value, since a stock `llama-server` does not check it.

## Provenance

It grew out of a Hugo-only mocked harness; the design + plan live in the author's notes
(`exocortex/docs/plans/2026-06-28-model-onboarding-benchmark-cli{-design,}.md`). The two agent
profiles mirror **Murmur8**, the author's personal-assistant app, and **Hugo**, its SMS front end —
the fixtures under `fixtures/` are captured from those real agents so the benchmark measures the
tool-calling behavior that actually matters in production.

Consumed by: [crucible](../crucible) (the author's fine-tuning pipeline) uses model-eval as its
evaluation gate — "model-eval measures, crucible distills and trains".

## What it does

```
model-eval run <hf-repo>[:<quant-file>] [--profile hugo,murmur8] [--case <id>] [--baseline none|cached:<id>|<id>] [--keep]
```

1. **Resolve** a GGUF from the HuggingFace repo (auto-picks `Q4_K_M` unless you pass `:<file>`; uses
   `HF_TOKEN` for gated repos). Pre-quantized GGUF only — if the repo has none, it fails with a clear
   message.
2. **Serve** it on the inference host (`frame` by default, `FRAME_SSH_HOST` to override): SSH in,
   download to `/var/lib/llama-server/models/` (skipped if already present), start an ad-hoc
   `llama-server` on a free port (8086+), health-check until ready.
3. **Benchmark** the candidate and the `--baseline` (default `qwen-agentic`) across the selected
   profiles. See [Durable store + baseline reuse](#durable-store--baseline-reuse) for the baseline modes.
4. **Emit** the data artifacts (below).
5. **Tear down**: stop the server. The GGUF is kept, so re-runs skip the download. `--keep` leaves
   the server running.

Other subcommands: `model-eval serve <hf-repo> [--port N]` and `model-eval stop --port N` for manual
control.

## Agent profiles

The harness is profile-driven (`src/profile.ts`). Each `AgentProfile` bundles a system prompt, a tool
surface, mock defaults, reply constraints, and a case set — all sourced from the **real** agent:

- **`hugo`** — Hugo's exact system prompt (extracted from `domain-murmur8.ts`) + the Murmur8 MCP tools
  plus the two `Parse Date Time` / `Convert Time` code-tool helpers. SMS reply constraints (≤320
  chars, no markdown).
- **`murmur8`** — the in-app agent's verbatim `AiOptions.SystemPrompt` + the Murmur8 MCP tool surface
  (no code tools). Portal-chat reply constraints (no length cap, markdown allowed).

Both share the deterministic mock engine and the pinned clock (`2026-06-26T18:00:00Z` = Fri 2:00 PM
`America/Detroit`).

## What it measures

- **Tool-correctness** — did the model call the right tool with the right args? (names resolved to
  IDs, calendar times local-no-`Z` + a separate `timeZone`, reminders in UTC, correct call order, no
  destructive guessing, no fabricated success, honest behavior on errors, pages through results).
  Deterministic, code-checked.
- **Latency** — per-case wall-clock; mean + p95 per model.
- **Reply-quality** — judged in a separate manual/agent pass against each case's rubric (see
  `JUDGING.md`). NOT produced by the CLI.

## Outputs (data only)

The CLI writes to `results/<timestamp>/` and makes no judgments:

| File | Contents |
|------|----------|
| `raw.jsonl` | every profile × model × case: full transcript (tool calls + args + mock responses + final reply), latency, tokens |
| `scores.json` | programmatic assertion results (tool-correctness) per case — deterministic |
| `summary.json` | machine-readable aggregates per profile × model: tool-correctness %, case pass-rate, latency mean/p95, ran/errored |
| `judging-bundle.md` | transcripts + per-case reply rubrics laid out for the reply-quality judge pass |

The judge pass reads the bundle + `raw.jsonl`, scores reply-quality, and writes `reply-verdicts.json`.
Any narrative/recommendation lives there, not in the CLI.

## Durable store + baseline reuse

`results/<timestamp>/` is disposable per-run scratch and stays **gitignored**. The durable,
**committed** comparison store is two things at the repo root:

| Path | Contents |
|------|----------|
| `registry.jsonl` | append-only — one JSON line per profile × model per run: `timestamp`, `gitSha`, the `summary.json` aggregates, and `source` (`live` or `cached`). This is the long-running record that makes runs comparable over time. |
| `baselines/<id>.jsonl` | the latest cached raw records for baseline model `<id>`, so a later run can fold them in without re-serving the baseline. |

Candidate model ids are **slugs of the GGUF filename** (`Qwen-AgentWorld-35B-A3B-UD-Q4_K_M.gguf` →
`qwen-agentworld-35b-a3b-ud-q4-k-m`), so the same model always lands under the same id across the
registry — runs stay comparable regardless of which results directory they came from.

`--baseline` controls the baseline behavior:

- **`<id>` (live, default `qwen-agentic`)** — serve/benchmark the baseline alongside the candidate and
  **refresh** `baselines/<id>.jsonl` with the fresh rows. Registry `source` = `live`.
- **`cached:<id>`** — do **not** serve the baseline; **fold** the stored `baselines/<id>.jsonl` rows
  (filtered to the selected `--profile`/`--case`) into this run's records. Registry `source` =
  `cached`. Fails if no cache exists yet — run once with `--baseline <id>` first.
- **`none`** — skip the baseline entirely; only the candidate is served and benchmarked.

The baseline (e.g. `qwen-agentic` on `frame:8081`) is a **pre-existing** instance — the CLI never
starts or stops it; teardown only stops the candidate server it launched. If you have no
long-running baseline instance of your own, use `--baseline none` (or register one in
`src/models.ts`).

## Raised-fidelity mocks

Mocks are deterministic but shaped like real Murmur8 MCP responses (full field sets, `nextCursor`
pagination, empty results, error payloads) — captured into `fixtures/responses-fixture.json`. The
case set deliberately exercises the failure modes that slipped past the old harness into production:
fabrication (claiming an action with no tool call), timezone/DST, pagination, and error recovery.

## Layout

| Path | Role |
|------|------|
| `src/cli.ts` | the CLI: `parseArgs` + `runCommand` (side effects injected) + `main` |
| `src/hf.ts` | HuggingFace GGUF resolver |
| `src/frame.ts` | ad-hoc `llama-server` serve/stop orchestration over SSH |
| `src/profile.ts` | the `AgentProfile` abstraction + registry |
| `src/profiles/hugo.ts`, `src/profiles/murmur8.ts` | the two agent profiles |
| `src/prompt.ts`, `src/murmur8-prompt.ts` | system-prompt builders (pinned clock) |
| `src/tools.ts`, `src/tools-murmur8.ts` | tool-def builders from the fixtures |
| `src/mock-engine.ts` | deterministic mocks (incl. `paginated` / `errorOnce`) |
| `src/case.ts`, `src/cases.ts`, `src/cases-fidelity.ts`, `src/cases-murmur8.ts` | case schema + sets |
| `src/score.ts`, `src/fabrication.ts` | the assertion scorer |
| `src/loop.ts` | the tool-calling loop |
| `src/run.ts` | `runProfiles` + result-writing helpers |
| `src/summary.ts`, `src/bundle.ts` | the two data-output emitters |
| `src/models.ts` | model registry + ephemeral-candidate factory |
| `fixtures/` | tool schemas, response shapes, the murmur8 prompt |
| `JUDGING.md` | the reply-quality judging pass |

## Prerequisites

- Node + `npm install`.
- Prompt sources (required, no baked-in defaults):
  - `HUGO_WORKFLOW_PATH` — path to the n8n workflow source containing the
    `const HUGO_SYSTEM_PROMPT = \`...\`` template literal. The `hugo` profile throws if unset.
  - `MURMUR8_APPSETTINGS_PATH` — path to an appsettings.json whose `AI.SystemPrompt` holds the
    murmur8 portal agent prompt. The `murmur8` profile throws if unset.
  - The unit suite does not need either set by hand — `vitest.config.ts` points both at the
    synthetic fixtures in `fixtures/` (`hugo-workflow-fixture.ts`, `murmur8-appsettings-fixture.json`).
- `haiku` baseline: `OPENROUTER_API_KEY` in env (never commit it).
- Local models: an inference host reachable over SSH — `ssh frame` by default, or set
  `FRAME_SSH_HOST=<your-host>` — with `llama-server` installed and
  `/var/lib/llama-server/models/` writable. `FRAME_API_KEY` falls back to a dummy. Gated HF repos:
  `HF_TOKEN` in env.

## Develop

```bash
npm install
npm test            # unit suite (network + SSH are injected, so this never touches frame/HF)
npx tsc --noEmit
```

## Adding a profile

Implement an `AgentProfile` (system prompt builder, `toolDefs`, `mockDefaults`, `replyConstraints`,
`cases`) and register it in `src/profile.ts`'s `PROFILES`. Source the prompt and tools from the real
agent — do not hand-approximate them.

## Adding a baseline model

One entry in `MODELS` (`src/models.ts`): `{ id, label, baseURL, apiKeyEnv, model, kind }`. The `model`
string must match what the endpoint serves (`curl http://<host>/v1/models`).

## Caveats

- **`memory-followup` cases score low for all models** partly by design: the mocks don't surface the
  prior turn's entity, so "move that to 4pm" has no ID to resolve. The reply judge distinguishes
  honest "couldn't find it" from confident hallucination, but both score as a tool-correctness fail.
- Large local models are slow over the full multi-turn case set. For long sweeps, launch detached
  (e.g. a `systemd-run --user` unit) and poll `results/<ts>/raw.jsonl`.
- Watch memory (`free -g`) on the inference host — `llama-server` instances share unified memory.
  Once a candidate proves out, promote it to a permanently-served instance (on the author's setup
  that means `hosts/frame/default.nix`, `services.llama-server-local.models`, in the homelab NixOS
  config).

## License

[MIT](LICENSE) — Copyright (c) 2026 Ross Chambers.
