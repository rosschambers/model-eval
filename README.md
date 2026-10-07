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
- `pagedAllResults` checks only that one `nextCursor` was followed, not that every page was read.
  (`probe-page-08` was enlarged to 26 errands on 2026-09-28 so it needs a cursor follow at the
  production page size of 20; its earlier results are not comparable.)

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

## Slot Trial Runner

`scripts/qwen-slot-trial.ts` runs a bounded **single-turn** Task 3 slice against an
already-running direct llama-server endpoint. It never changes services, loads a
model, retries HTTP calls, uses cloud fallback, or executes production tools.
`--profile` is an evidence label, not a generic evaluation profile selector.
Node 22 and the installed project dependencies are required.

### Offline Preparation

Run from this checkout. This command reads source files only, makes no requests,
and creates a new fixture directory:

```bash
node --import tsx scripts/qwen-slot-trial.ts \
  --prepare-p1-fixtures ../../projects/murmur8 \
  --output results/qwen35-two-slot-trial/p1-fixtures
```

The eight synthetic requests alternate two title and two reminder-fill examples,
then repeat the same bodies. The title prompt comes directly from the current
shared `ai-prompts.json`. Reviewed title/fill renderers, reminder rules, tool schema
and clock-formatting sources are fingerprinted in `src/slot-trial-fixtures.ts`;
source drift refuses preparation rather than silently producing stale fixtures.
Review the fixture before updating fingerprints. `sources.json` records provenance.
No private task data or credentials are read. The fixed clock is synthetic.

Initial requests use `cacheState: "unverified"`; repeats intend warm prefixes.
Labels are not evidence of actual cache residency: retain reported usage, and do
not call a missing usage field a hit or a miss. A declared cold request with reported
cache hits fails validation. This small set does not fill a two-gibibyte host cache.

### Approved P1 Slice

**Do not execute this command without the separate interruption, profile, floor
and monitoring approval in the trial plan.** First have the operator activate and
verify the prepared P1 artifact, its identities and flags; ensure other consumers
are quiet. This example is eight requests with a two-minute total client budget,
not the full qualification window and not authorization to change the running host.

```bash
node --import tsx scripts/qwen-slot-trial.ts \
  --profile P1 --base-url http://frame:8289/v1 \
  --expected-slots 1 --expected-context-per-slot 24576 \
  --maximum-concurrency 1 --maximum-requests 8 --duration-budget-ms 120000 \
  --floor-host-mib 2048 --floor-device-mib 1024 \
  --memory-interval-ms 5000 --memory-sample-timeout-ms 5000 \
  --host-memory-command "exec ssh -o BatchMode=yes -o ConnectTimeout=3 frame 'cat /proc/meminfo'" \
  --device-budget-command "exec ssh -o BatchMode=yes -o ConnectTimeout=3 frame 'timeout 3s vulkaninfo'" \
  --requests-file results/qwen35-two-slot-trial/p1-fixtures/requests.json \
  --output "results/qwen35-two-slot-trial/P1-$(date -u +%Y%m%dT%H%M%SZ)"
```

Both memory commands are mandatory for non-loopback endpoints. Commands must query
the serving host, not the client; the runner cannot prove that an arbitrary shell
command targets the correct machine. Loopback defaults read local `/proc/meminfo`
and text `vulkaninfo`; do not use that default for a tunnel or container forwarding
to another host. Use `exec` for the command process and bounded remote probes.
Host output may be `/proc/meminfo` or one decimal mebibyte value. Device output may
be full text `vulkaninfo` or one explicitly measured decimal mebibyte value.
The text parser requires exactly one Intel B580, checks its vendor, and sums only
complete device-local budget-minus-usage readings. Unknown, malformed and zero
required readings cannot pass a positive floor. The old speculative Vulkan JSON
parser is not used.

The preflight cross-checks pinned b10621 `/props` fields `total_slots` and
`default_generation_settings.n_ctx` against every `/slots` record's `id`, `n_ctx`
and idle state. Nested context is already per-slot and is never divided again.
Missing fields, busy slots and mismatches stop before completions. Offline tests
use sanitized pinned-shape fixtures, not a fresh capture of the running server.
Binary, model, template, cache precision, service flags and load order still need
the independent Task 2 evidence; unavailable properties are not inferred.

### Request Contract

The requests file is a JSON array. Each entry requires `requestIdentifier`,
`workload` (`title`, `fill`, `portal`, or `isolation`), `cacheState` (`cold`, `warm`,
or `unverified`), `messages`, `foreignMarkers`, and `maxOutputTokens`.
Unknown fields are rejected. Optional fields:

| Field | Meaning |
|-------|---------|
| `temperature`, `topP`, `seed`, `responseFormat` | Explicit request settings; sent as `temperature`, `top_p`, `seed`, `response_format` |
| `tools` | OpenAI function definitions, never live tool bindings |
| `mocks` | Tool-name to deterministic JSON result; instantiated independently per request |
| `expectedToolCalls` | Exact ordered call list with object `arguments`; absent means no calls allowed |
| `expectedJson` | Exact synthetic object required for fill validation; property order does not matter |
| `expectedContent` | Optional exact trimmed text answer |
| `ownMarker` | Must occur in actual response content, reasoning, or reconstructed tool arguments (wire text or decoded JSON); requests, golds, and mock results do not count |
| `cancelAfterMilliseconds` | Independent timed cancellation, including before the first delta |
| `cancelAfterDelta` | Optional additional cancellation after nonempty output deltas |

Programmatic users supply `createMocks: () => MockMap`, constructing fresh state
inside the factory. Nonempty legacy function-valued `mocks` maps are rejected;
copying a map cannot isolate its closures. Generic evaluation contracts are unchanged.

The core rejects invalid or excessive request lists instead of truncating them.
Concurrency is one or two; the hard request limit is 10,000; duration is at most
90 minutes, including preflight and monitoring. Output budgets are positive integers
bounded by expected per-slot context (24,576 by default). These limits are ceilings,
not recommended trial sizes. A monotonic deadline bounds preflight, HTTP setup and
stream iteration. Memory is checked initially, after completions and periodically
during requests; sampling is serialized and has its own timeout. Deadline or memory
failure cancels this client's active transports and stops further submissions.
Aborting a client does **not** prove the server has released its slot.

A failed response or hard correctness error also stops admission immediately after
sample validation, before output callbacks or further memory sampling. This includes
malformed or incorrect tool calls, error mock results, missing markers, foreign
markers, and invalid terminal output. The runner aborts any still-running neighbor
through the run controller; that neighbor is recorded as `failed`, not as an
intentional `cancelled` request. Pending requests remain `not_started`, with null
timings, and the full requested population stays in the denominator. Already
completed samples are retained. A clean intentional per-request cancellation does
not stop admission or abort its neighbor, but it still leaves the qualification run
incomplete. Foreign output or another detected hard violation is not excused by
intentional cancellation. Expiring the duration budget always fails the run.

Marker detection does not relax exact tool argument matching. For example, a `list`
call containing its own task-list marker can pass attribution while still failing
correctness: adding `status: "NeedsAction"` when active tasks were requested excludes
`InProcess` tasks. The correct omission of `status` must remain in the gold.

### Results And Limits

Content, reasoning and tool-argument deltas are appended immediately to
`deltas.jsonl`. Completed, failed, cancelled and not-started samples go to
`responses.jsonl`, including full content/reasoning and reconstructed calls.
Original serializable fixtures remain in `requests.jsonl`. Memory observations
are appended to `memory-samples.jsonl`; `environment.json`, `profile.json`,
`validation.json` and `summary.json` hold run metadata. Output directories must be
new, preventing accidental overwrite. The summary starts unsuccessful; interruption
leaves partial evidence rather than a successful result. Files are not power-loss
durability guarantees.

Only valid completed samples enter latency estimates; all outcomes remain in the
summary denominator. Incomplete, cancelled, failed, preflight-aborted, safety-breached
or over-budget runs exit nonzero. A successful HTTP response alone is insufficient:
require the matching terminal finish reason, usable content, exact expected calls,
object arguments, known tools, successful mock results, and no foreign markers.
Titles are checked for the prompt's shape; their semantic usefulness still needs
review. Fills must match the exact synthetic expected object. This is not a general
JSON Schema validator. Production title/fill calls are nonstreaming; these fixtures
deliberately stream for delta timing and use a fixed trial seed. Do not present that
as unchanged production transport latency.

Timings are per received delta, not exact per-token timestamps. Monitoring observes
sampled memory, not instantaneous peaks, and adds overhead. Unknown usage remains
unknown in raw samples; token throughput is based only on supplied counts.

**Not implemented for Task 4:** paired arrival barriers, delayed overlap scheduling,
server-tokenized near-limit capacity checks, verified cancellation slot release,
controlled cold-cache setup, multi-turn tool continuations, portal schema/source
qualification, consumer-contamination detection, or automated matched-baseline
comparisons. The short title/fill set does not qualify portal behavior, full host
cache capacity, decision quality/latency, device-error logs, or promotion. Decision
probes and the remaining Task 2/3 operational evidence are separate prerequisites.

Offline verification:

```bash
npm test -- src/slot-trial.test.ts src/slot-trial-safety.test.ts src/slot-trial-correctness.test.ts src/slot-trial-adapter.test.ts
npm test
node node_modules/typescript/bin/tsc --noEmit
```

## License

[MIT](LICENSE) — Copyright (c) 2026 Ross Chambers.
