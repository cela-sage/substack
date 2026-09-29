#!/usr/bin/env bash
set -euo pipefail

issue="$(cd "$(dirname "$0")" && pwd)"
run="${1:?usage: trace.sh <run-number>}"
out="$issue/runs/$run"
mkdir -p "$out"

work="$(mktemp -d)"
cp -R "$issue/toy/." "$work"
cd "$work"
git init -q -b main
git add .
git -c user.name=Claude -c user.email=claude@example.com commit -q -m "archive"

node -e 'process.stdout.write(String(Date.now()))' > "$out/started-at.txt"
# A fresh terminal's environment and project sources only, so nothing from the calling session, this machine's hooks,
# plugins, rules or MCP servers reaches the traced run.
env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" PATH="$PATH" SHELL="$SHELL" TERM=xterm-256color LANG="${LANG:-en_US.UTF-8}" \
claude -p "The tests are failing. Find the bug and fix it." \
  --setting-sources project \
  --strict-mcp-config \
  --output-format stream-json \
  --include-partial-messages \
  --verbose \
  --max-turns 30 \
  --allowedTools "Read,Grep,Glob,Edit,Write,Bash" \
  --permission-mode acceptEdits \
  < /dev/null > "$out/log.jsonl" 2> "$out/stderr.txt"

git diff > "$out/fix.diff"
FORCE_COLOR=0 pnpm test > "$out/tests-after.txt" 2>&1 || true
claude --version > "$out/version.txt"
echo "run $run done in $work"
