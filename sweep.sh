#!/usr/bin/env bash
# Full candidate sweep: three HF models x both profiles. The baseline
# (qwen-agentic = the production model already on frame:8081) is benchmarked
# LIVE once on the first model, which caches it to baselines/qwen-agentic.jsonl;
# the remaining models reuse that cache (--baseline cached:qwen-agentic) so the
# baseline is never re-run. Sequential so frame's unified memory only ever holds
# one ad-hoc candidate at a time; each run tears its server down before the next.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

run() { echo "=== SWEEP $(date -Is) :: $1 ($2) ==="; npx tsx src/cli.ts run "$1" --profile hugo,murmur8 --baseline "$2"; echo "=== DONE  $(date -Is) :: $1 (exit $?) ==="; }

# 1) live baseline → caches qwen-agentic
run "empero-ai/Qwythos-9B-Claude-Mythos-5-1M-GGUF:Qwythos-9B-Claude-Mythos-5-1M-MTP-Q4_K_M.gguf" "qwen-agentic"
# 2-3) reuse the cached baseline
run "yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF" "cached:qwen-agentic"
run "unsloth/Qwen-AgentWorld-35B-A3B-GGUF" "cached:qwen-agentic"

echo "=== SWEEP ALL COMPLETE $(date -Is) ==="
