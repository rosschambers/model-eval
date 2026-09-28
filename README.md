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

## Transport Fidelity

Hugo and murmur8 (including their probe profiles) render both history and current tool exchanges
for their production chat-completions paths. Hugo current steps use one assistant/result pair per
call, toolkit `tool` and call `id` arguments, MCP text envelopes or code-tool string envelopes.
Unlike stored history, current arguments keep insertion order and current tool messages omit
`name`. The portal keeps grouped calls and wraps database-formatted JSON in `<tool-result>` data
tags. Screen context and the clock remain last on every request, including both intervention phases.
Other profiles retain unchanged generic assistant/tool transport, but the shared context-placement
correction applies to every profile. In particular, `voice` now places its clock after the tool
exchange on the second request, without duplicating it. `voice` is still a profile-only placeholder,
not a verified portal execution path.

## Payload Fidelity

The murmur8 **read** tools answer in the deployed murmur8 shapes (murmur8 `50cd9628`), built in
`src/murmur8-results.ts` and served by `src/mock-engine.ts` (`listMock`, `searchMock`,
`murmur8Mocks`, `paginated`):

- `search` returns SearchTool's `{TotalCount, Items:[{EntityType, EntityId, Title, Subtitle,
  ParentName, Score}]}`, PascalCase with nulls written. The Subtitle is "Parent · local date"
  (plus the local time for timed events and task due instants). Tasks of every status and calendar
  events are searchable; reminders are not, as in production. A `types` filter is honoured.
- `list` rows are the lean production rows with null members omitted and `nextCursor` always
  written: calendars and task lists `{id, name}` sorted by name; tasks `{id, title, status,
  dueDate?, priority, localDueDate?, localTimeZone?}`; reminders `{id, revision, title, remindAt,
  localRemindAt, localTimeZone}`; calendar events `{id, title, occurrenceStart, occurrenceEnd,
  isAllDay, localStart, localEnd, localTimeZone}` inside `{results, nextCursor: null, truncated}`.
  Local fields come from the pinned clock's timezone (America/Detroit).
- Paging follows ListTool and CursorPaginator: `pageSize` defaults to 20 and is clamped to 1..100,
  tasks default to active only (`status` filters one status; `All`/`Completed`/`Cancelled` without a
  `taskListId` get the production error), reminders default to Pending (history statuses need a
  created range), rows sort newest-updated first, cursors are base64 of `{"s":sortValue,"i":id}`, an
  unreadable cursor restarts at page 1, and `nextCursor` is `null` once exhausted. Calendar events
  honour the default now..now+7 days window, an explicit local or UTC `start`/`end`, and `calendarId`.
- Payload text is written the way System.Text.Json's default encoder writes it (`·` is `\u00B7`,
  an apostrophe `\u0027`), which the Hugo MCP path sends raw; the portal renderer re-reads it as
  database JSON, as production does.

Remaining payload gaps:

- Mutations are not production-shaped. `create`/`update` echo input fields with synthetic or
  supplied identifiers, `delete` returns `{deleted:true}`, and none of them requires the `revision`
  production demands on update and delete of tasks, events, calendars, task lists and reminders
  (production rejects a call without it with "Missing required parameter: 'revision'").
- `get` returns only `id` and `found`, not the detail views (with `revision` and local fields).
- `search` does not match the query text (pg_trgm `word_similarity`): every seeded task and event
  is returned for any query of two or more characters.
- `list` ignores the created/updated date filters, `createdBy`/`updatedBy`/`parentTaskId`, and every
  type other than tasks, task lists, calendars, calendar events and reminders (they list empty).
  Recurring events are seeded as already-expanded occurrences.
- Structured mock errors are tool payloads, not simulated n8n node failures or network exceptions.
  Business-rule errors match production (`{"error": "..."}`), but a tool exception (a missing
  required argument, an unparseable `start`) is sent as `{"error": "<MCP message>"}` JSON where
  production sends the bare MCP message text, and the portal's own exception text is not modelled.
- The portal date helper still uses the harness's JavaScript implementation, not the production C#
  validation rules.
- `probe-page-08` seeds twelve open tasks, which fit one production page, so it no longer requires a
  cursor follow; `pagedAllResults` checks only that one `nextCursor` was followed.

Portal argument-key normalization and invalid or non-object JSON argument handling remain fidelity
gaps. Production normalizes argument keys against tool schemas and catches tool-execution errors;
the harness does not fully reproduce these paths. Malformed JSON can be retained under `_raw`,
while non-object values such as `null` or strings can fail validation or execution differently.
The transport renderer does not correct these argument-processing or error-handling differences.

Cached baselines do not fingerprint renderer code. Re-run affected baselines before comparing new
results: `results/2026-09-27-v7-history-rebaseline-run2` is an immutable **history-only** baseline,
not a current-transport baseline. Keep old results unchanged; record new runs separately.

## Tech stack

TypeScript, Node, Vitest. No frameworks. The profiles mirror two real agents (an SMS assistant
and an in-app assistant) with their production system prompts and tool surfaces.

## Requirements

- An SSH-accessible host with `llama-server` installed and `/var/lib/llama-server/models/` writable.
  Default target: `ssh frame`. Override with `FRAME_SSH_HOST`.
- `HUGO_WORKFLOW_PATH` — path to the n8n workflow source containing the Hugo system prompt.
- `MURMUR8_APPSETTINGS_PATH` — path to the murmur8 API's appsettings.json. The portal prompt is taken
  from its `AI.SystemPrompt` if present, otherwise from the shared prompts file beside it
  (`../Murmur8.Infrastructure/AI/ai-prompts.json`, override with `MURMUR8_AI_PROMPTS_PATH`) — the same
  layering murmur8 itself uses.
- `fixtures/tools-fixture.json` is a capture of murmur8's served `tools/list`. Re-capture it after any
  murmur8 tool-schema change; the mock engine enforces its required arguments like production does.
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
