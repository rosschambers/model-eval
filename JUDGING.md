# Reply-Judging Pass

The programmatic scorer (`src/score.ts`) already grades **tool-calling**: did the
model call the right tools with the right arguments? That is fully automated and
lands in `scores.json` / `raw.jsonl`.

This pass grades the one thing a deterministic scorer cannot: the quality of the
**final SMS reply** the model sends back to the user. It is meant to be run by a
human or an agent after a benchmark sweep, and its output is `reply-verdicts.json`.

## Input

For a given run, open `results/<ts>/judging-bundle.md` — it lays out one section
per non-error record (profile, model, caseId, the case's `replyRubric`, and the
model's final reply), and lists errored records under a `## Skipped (errored)`
section. Cross-reference `results/<ts>/raw.jsonl` for the full record when you
need more than the bundle shows. Each `raw.jsonl` line is one record:

- `transcript.finalText` — the reply the model would have texted the user. This
  is the thing you are judging.
- `caseId` — the matching case's `replyRubric` (already inlined in the bundle)
  describes what a correct reply must convey.
- `error` — if present, **skip** the record. There is no reply to judge.

## Rubric (apply to every non-error record)

A reply **passes only if all four hold**:

1. **Accurate** — it accurately states what was done or found, matching the
   case's `replyRubric`. (For lookups, reporting "nothing scheduled" is fine if
   that is the truthful result; for disambiguation cases, asking which item is
   meant is the correct reply, not acting.)
2. **Length** — 320 characters or fewer.
3. **Plain text** — no markdown, no emoji, no bullet points or numbered lists.
4. **No narration** — no step-by-step process talk ("let me…", "now I'll…",
   "I'm going to…", "first I'll…").

If any one fails, the reply fails. The `reason` should name the first thing that
broke (or "ok" / a short positive note when it passes).

## Output

Write `results/<ts>/reply-verdicts.json` — a JSON array with **one entry per
non-error record**:

```json
[
  { "caseId": "cal-tz-01", "model": "haiku", "passed": true, "reason": "Accurate, 92 chars, plain text." },
  { "caseId": "remind-01", "model": "qwen-agentic", "passed": false, "reason": "Narrates steps ('let me set that up')." }
]
```

Field shapes:

| Field    | Type      | Notes                                              |
| -------- | --------- | -------------------------------------------------- |
| `caseId` | string    | From the record.                                   |
| `model`  | string    | The model id from the record (e.g. `haiku`).       |
| `passed` | boolean   | True only if all four rubric points hold.          |
| `reason` | string    | One short line; name the first failure or "ok".    |

`reply-verdicts.json` is the final artifact of this pass — write it next to the
other `results/<ts>/` data (`raw.jsonl`, `scores.json`, `summary.json`,
`judging-bundle.md`). The CLI is a pure data producer; there is no report-render
step. Any human-readable rollup is produced by the judging pass itself.
