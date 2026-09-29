#!/usr/bin/env bash
set -euo pipefail

issue="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$issue/lib.sh"
server="$issue/setups/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js"

# A variant is the stock toy plus a committed CLAUDE.md, an MCP server, or both. It prints the extra claude flags.
prepare() {
  local variant="$1" work="$2" out="$3"
  mkdir -p "$out"
  if [[ "$variant" == claude-md || "$variant" == both ]]; then
    cp "$issue/setups/CLAUDE.md" "$work/CLAUDE.md"
    git -C "$work" add CLAUDE.md
    git -C "$work" -c user.name=Claude -c user.email=claude@example.com commit -q -m "project instructions"
  fi
  if [[ "$variant" == mcp || "$variant" == both ]]; then
    jq -n --arg server "$server" --arg work "$work" \
      '{mcpServers: {filesystem: {command: "node", args: [$server, $work]}}}' > "$out/mcp.json"
    printf '%s\n' --mcp-config "$out/mcp.json"
  fi
}

# The prompt goes before the flags, because --mcp-config takes a list and would swallow a prompt placed after it.
session() {
  local variant="$1" out="$2" prompt="$3" turns="$4" work flags=()
  work="$(new_workdir "$issue/toy")"
  while IFS= read -r flag; do flags+=("$flag"); done < <(prepare "$variant" "$work" "$out")
  node -e 'process.stdout.write(String(Date.now()))' > "$out/started-at.txt"
  (cd "$work" && "${clean_env[@]}" claude -p "$prompt" \
    --setting-sources project \
    ${flags[@]+"${flags[@]}"} \
    "${session_flags[@]}" \
    --include-partial-messages \
    --max-turns "$turns" \
    < /dev/null > "$out/log.jsonl" 2> "$out/stderr.txt")
  git -C "$work" diff > "$out/fix.diff"
  (cd "$work" && FORCE_COLOR=0 pnpm test > "$out/tests-after.txt" 2>&1) || true
  claude --version > "$out/version.txt"
}

for variant in stock claude-md mcp both; do
  session "$variant" "$issue/runs/probes/$variant" "Reply with the single word: ok" 1
  echo "probe $variant done"
done

# Issue 1's task on the heaviest setup, so the fix has a measured cost beside the arithmetic.
session both "$issue/runs/both-full" "The tests are failing. Find the bug and fix it." 30
node "$issue/analyze.ts" "$issue/runs/both-full/log.jsonl" > "$issue/runs/both-full/summary.json"
echo "full run done"
