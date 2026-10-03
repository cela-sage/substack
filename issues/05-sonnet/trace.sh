#!/usr/bin/env bash
set -euo pipefail

issue="$(cd "$(dirname "$0")" && pwd)"
model="${1:?usage: trace.sh <opus|sonnet> <run-name>}"
out="$issue/runs/$model-${2:?usage: trace.sh <opus|sonnet> <run-name>}"
mkdir -p "$out"

case "$model" in
  # Opus runs at Claude Code's own default, so nothing pins it.
  opus) model_flag=() ;;
  sonnet) model_flag=(--model claude-sonnet-5-5) ;;
  *)
    echo "model must be opus or sonnet" >&2
    exit 2
    ;;
esac

work="$(mktemp -d)"
cp -R "$issue/toy/." "$work"
git -C "$work" init -q -b main
git -C "$work" add .
git -C "$work" -c user.name=Claude -c user.email=claude@example.com commit -q -m "archive"

node -e 'process.stdout.write(String(Date.now()))' > "$out/started-at.txt"
(cd "$work" && env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" PATH="$PATH" SHELL="$SHELL" TERM=xterm-256color LANG="${LANG:-en_US.UTF-8}" \
  claude -p "The tests are failing. Find the bug and fix it." \
  ${model_flag[@]+"${model_flag[@]}"} \
  --setting-sources project \
  --strict-mcp-config \
  --output-format stream-json \
  --include-partial-messages \
  --verbose \
  --max-turns 30 \
  --allowedTools "Read,Grep,Glob,Edit,Write,Bash" \
  --permission-mode acceptEdits \
  < /dev/null > "$out/log.jsonl" 2> "$out/stderr.txt")
node -e 'process.stdout.write(String(Date.now()))' > "$out/ended-at.txt"

git -C "$work" diff > "$out/fix.diff"
(cd "$work" && FORCE_COLOR=0 pnpm test > "$out/tests-after.txt" 2>&1) || true
claude --version > "$out/version.txt"
echo "$model run done in $work"
