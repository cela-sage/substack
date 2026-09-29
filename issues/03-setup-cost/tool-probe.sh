#!/usr/bin/env bash
set -euo pipefail

issue="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$issue/lib.sh"
server="$issue/setups/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js"

# The heaviest setup again, this time with a task that needs one of the server's tools, to watch its description load.
work="$(new_workdir "$issue/toy")"
cp "$issue/setups/CLAUDE.md" "$work/CLAUDE.md"
git -C "$work" add CLAUDE.md
git -C "$work" -c user.name=Claude -c user.email=claude@example.com commit -q -m "project instructions"
out="$issue/runs/both-tool"
mkdir -p "$out"
jq -n --arg server "$server" --arg work "$work" \
  '{mcpServers: {filesystem: {command: "node", args: [$server, $work]}}}' > "$out/mcp.json"
node -e 'process.stdout.write(String(Date.now()))' > "$out/started-at.txt"
# The server's tool has to be allowed, since a headless run refuses any tool it would otherwise ask about.
(cd "$work" && "${clean_env[@]}" claude -p "Use the filesystem server's list_directory tool on this folder and reply with how many files it has." \
  --setting-sources project \
  --mcp-config "$out/mcp.json" \
  --strict-mcp-config \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --allowedTools "Read,Grep,Glob,Edit,Write,Bash,ToolSearch,mcp__filesystem__list_directory" \
  --permission-mode acceptEdits \
  --max-turns 8 \
  < /dev/null > "$out/log.jsonl" 2> "$out/stderr.txt")
claude --version > "$out/version.txt"
node "$issue/analyze.ts" "$out/log.jsonl" > "$out/summary.json"
echo "tool probe done"
