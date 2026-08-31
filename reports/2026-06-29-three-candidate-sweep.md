# Three-Candidate Sweep — 2026-06-29

First full multi-agent sweep with the generalized `model-eval` CLI. Three HuggingFace candidates
benchmarked across **both** agent profiles (hugo, murmur8) against the production baseline
`qwen-agentic` (`qwen3.6-35b-a3b-opus-abliterated-Q4_K_M` on frame:8081). Baseline benchmarked live
once (model 1) and reused from cache for models 2–3.

Tool-correctness + latency are programmatic (this CLI). Reply-quality (the manual judge pass) not yet
run. Single repeat — temp 0.7 means ±1 case of run-to-run noise; use `--repeat N` to denoise.

## Leaderboard

### hugo profile (43 cases)
| Model | Tool-correctness | Case pass | Latency mean / p95 |
|-------|------------------|-----------|--------------------|
| **qwen-agentic** (baseline) | **88.4%** | **81.4%** | **4.3s / 8.2s** |
| Qwythos-9B | 87.7% | 79.1% | 14.2s / 34.6s |
| gemma4-v2-12B | 81.3% | 54.8% | 35.8s / 60.6s (1 errored) |
| Qwen-AgentWorld-35B-A3B | 63.2% | 55.8% | 33.3s / 105s |

### murmur8 profile (19 cases)
| Model | Tool-correctness | Case pass | Latency mean / p95 |
|-------|------------------|-----------|--------------------|
| **qwen-agentic** (baseline) | **76.1%** | **52.6%** | **3.7s / 12.5s** |
| Qwythos-9B | 74.6% | 47.4% | 10.9s / 21.3s |
| gemma4-v2-12B | 76.1% | 36.8% | 27.8s / 53.8s |
| Qwen-AgentWorld-35B-A3B | 18.3% | 26.3% | 26.7s / 167s |

## Recommendation

**Keep `qwen-agentic` in production.** No candidate beat it on accuracy, and it is 3–20× faster.

- **Qwythos-9B** is the only real contender — at parity on tool-correctness (within ~1.5 pts both
  profiles) but ~3× slower with no upside.
- **gemma4-v2-12B** — poor case-pass and brutal latency (60s p95); dense 12B.
- **Qwen-AgentWorld-35B-A3B** — biggest disappointment despite the agentic branding: 18% tool-
  correctness on murmur8, 105–167s p95. Likely over-reasons and/or emits tool calls in a format
  llama-server/the harness doesn't parse. Worth a follow-up (chat-template / tool-format check) before
  writing it off, but not a candidate as-is.

The **MoE latency advantage is decisive**: the 35B-A3B baseline (~3B active) runs 8s p95 while the
dense 9B/12B candidates are 21–60s.

## murmur8 profile is lower than hugo — why

Even the baseline scores ~53% case-pass on murmur8 vs ~81% on hugo. Investigation (baseline = oracle:
where the best model fails, suspect the case) found a mix of harness bugs and real findings:

**Fixed (false negatives — over-strict assertions):**
- `m8-ambig-01`: required `toolCalled search`, but resolving ambiguous matches via `list` then asking
  is equally correct → relaxed to `toolCalledAnyOf ['search','list']`.
- reminder `remindAt`: `argIsUtc` rejected offset-form timestamps (`...-04:00`) that are the *same
  instant* as the `Z` form → added an `argInstant` assertion (instant-equivalence; still rejects
  ambiguous local-naive times). Applied to all `remind-*` / `m8-remind-*` cases.

After these fixes the baseline murmur8 case-pass rose **53% → 63%**, a truer floor.

**Real findings (NOT harness bugs) — see the murmur8 agent improvement plan:**
1. **No date/time helper.** The murmur8 in-app agent has no `Parse_Date_Time`-equivalent (hugo does),
   so it must do UTC offset math unaided and gets reminder times wrong (`m8-remind-01`: set the *now*
   instant instead of 6pm). Faithful to the real agent → murmur8 should add a date helper.
2. **Portal prompt is more fabrication-prone / less action-biased** than Hugo's SMS prompt. The
   baseline fabricated completions (`m8-mem-01/02` claimed "moved it"/"added milk" with no tool call),
   offered to create instead of completing (`m8-done-01`), and acted on an ambiguous request
   (`m8-ambig-02`). Mirror Hugo's anti-fabrication + action-bias prompt work.

Plan: `murmur8/docs/plans/2026-06-29-murmur8-agent-time-and-fabrication.md`.
