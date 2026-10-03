#!/usr/bin/env bash
set -euo pipefail

issue="$(cd "$(dirname "$0")" && pwd)"
agent="${1:?usage: trace.sh <claude|codex> <run-name>}"
out="$issue/runs/$agent-${2:?usage: trace.sh <claude|codex> <run-name>}"
prompt="The tests are failing. Find the bug and fix it."
mkdir -p "$out"

work="$(mktemp -d)"
cp -R "$issue/toy/." "$work"
git -C "$work" init -q -b main
git -C "$work" add .
git -C "$work" -c user.name=Claude -c user.email=claude@example.com commit -q -m "archive"

# A fresh terminal's environment, so nothing from the calling session or this machine's settings reaches either agent.
clean_env=(env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" PATH="$PATH" SHELL="$SHELL" TERM=xterm-256color LANG="${LANG:-en_US.UTF-8}")

node -e 'process.stdout.write(String(Date.now()))' > "$out/started-at.txt"
case "$agent" in
  claude)
    (cd "$work" && "${clean_env[@]}" claude -p "$prompt" \
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
    claude --version > "$out/version.txt"
    ;;
  codex)
    # Only the login, linked so a token refresh lands in the real file; no user config, AGENTS.md or memories.
    codex_home="$(mktemp -d)"
    ln -s "$HOME/.codex/auth.json" "$codex_home/auth.json"
    # An empty home too, because Codex also loads skills from ~/.agents and its shell sources ~/.zprofile.
    empty_home="$(mktemp -d)"
    # Corepack's cache is the one thing kept, since the sandbox can't download the pnpm the toy pins.
    (cd "$work" && "${clean_env[@]}" HOME="$empty_home" COREPACK_HOME="$HOME/.cache/node/corepack" CODEX_HOME="$codex_home" codex exec "$prompt" \
      --json \
      --sandbox workspace-write \
      < /dev/null > "$out/log.jsonl" 2> "$out/stderr.txt")
    node -e 'process.stdout.write(String(Date.now()))' > "$out/ended-at.txt"
    cp "$(find "$codex_home/sessions" -name 'rollout-*.jsonl' | head -1)" "$out/session.jsonl"
    [ -L "$codex_home/auth.json" ] || echo "the Codex login link was replaced during the run" >&2
    rm -rf "$codex_home" "$empty_home"
    codex --version > "$out/version.txt"
    ;;
  *)
    echo "agent must be claude or codex" >&2
    exit 2
    ;;
esac

git -C "$work" diff > "$out/fix.diff"
(cd "$work" && FORCE_COLOR=0 pnpm test > "$out/tests-after.txt" 2>&1) || true
echo "$agent run done in $work"
