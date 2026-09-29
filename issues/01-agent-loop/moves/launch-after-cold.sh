#!/usr/bin/env bash
set -euo pipefail

moves="$(cd "$(dirname "$0")" && pwd)"
issue="$(dirname "$moves")"
job_output="${1:?usage: launch-after-cold.sh <cold-job-output-file>}"

until grep -q '^run cold done in ' "$job_output" 2>/dev/null; do
  sleep 20
done
cold_work="$(grep '^run cold done in ' "$job_output" | sed 's/^run cold done in //')"

# Cold is proven by the log, not the clock: turn 1 has to read next to nothing from the cache.
first_read="$(grep '^{' "$issue/runs/cold/log.jsonl" | jq -s '[.[] | select(.type == "assistant")][0].message.usage.cache_read_input_tokens')"
echo "cold run: turn 1 read $first_read tokens from the cache, folder $cold_work"

bash "$moves/after-cold.sh" "$cold_work"
