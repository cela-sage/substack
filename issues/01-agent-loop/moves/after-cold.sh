#!/usr/bin/env bash
set -euo pipefail

moves="$(cd "$(dirname "$0")" && pwd)"
issue="$(dirname "$moves")"
source "$issue/lib.sh"
cold_work="${1:?usage: after-cold.sh <cold-run-workdir>}"

# Same folder as the cold run, first with its fix still in place, then reset to the state its first turn saw.
probe_setup "$cold_work" "$moves/same-folder/dirty" --setting-sources project
git -C "$cold_work" checkout -q -- .
probe_setup "$cold_work" "$moves/same-folder/clean" --setting-sources project

pointed='pnpm test fails on "page 1 is the five newest issues" and "page 3 holds the two oldest". Find the bug and fix it.'
for n in 1 2 3; do
  trace_session "$(new_workdir "$issue/toy")" "$moves/pointed/$n" "$pointed"
done

task1="The tests are failing. Find the bug and fix it."
task2="Add a pageCount() export to src/page.js that returns how many pages the archive has, which is 3 for the current 12 issues, and add a test for it."
one="$(new_workdir "$issue/toy")"
trace_session "$one" "$moves/two-tasks/one-session/1" "$task1"
trace_session "$one" "$moves/two-tasks/one-session/2" "$task2" --continue
two="$(new_workdir "$issue/toy")"
trace_session "$two" "$moves/two-tasks/two-sessions/1" "$task1"
trace_session "$two" "$moves/two-tasks/two-sessions/2" "$task2"

# Last, because it is the only step that loads the personal hooks. Its log is never kept, only the token counts.
lean="$(new_workdir "$issue/toy")"
probe_setup "$lean" "$moves/lean-setup/stock" --setting-sources project
probe_setup "$lean" "$moves/lean-setup/personal" --setting-sources user,project

for summary in "$moves"/pointed/* "$moves"/two-tasks/*/*; do
  node "$issue/analyze.ts" "$summary/log.jsonl" > "$summary/summary.json" 2> /dev/null
done
echo "moves done"
