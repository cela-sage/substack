# shellcheck shell=bash

clean_env=(env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" PATH="$PATH" SHELL="$SHELL" TERM=xterm-256color LANG="${LANG:-en_US.UTF-8}")

# Tools render first in the cached prefix, so a probe must offer exactly the tools a traced session does to hit its cache.
session_flags=(
  --strict-mcp-config
  --output-format stream-json
  --verbose
  --allowedTools "Read,Grep,Glob,Edit,Write,Bash"
  --permission-mode acceptEdits
)

new_workdir() {
  local work
  work="$(mktemp -d)"
  cp -R "$1/." "$work"
  git -C "$work" init -q -b main
  git -C "$work" add .
  git -C "$work" -c user.name=Claude -c user.email=claude@example.com commit -q -m "archive"
  printf '%s' "$work"
}

trace_session() {
  local work="$1" out="$2" prompt="$3"
  shift 3
  mkdir -p "$out"
  node -e 'process.stdout.write(String(Date.now()))' > "$out/started-at.txt"
  (cd "$work" && "${clean_env[@]}" claude -p "$@" "$prompt" \
    --setting-sources project \
    "${session_flags[@]}" \
    --include-partial-messages \
    --max-turns 30 \
    < /dev/null > "$out/log.jsonl" 2> "$out/stderr.txt")
  git -C "$work" diff > "$out/fix.diff"
  (cd "$work" && FORCE_COLOR=0 pnpm test > "$out/tests-after.txt" 2>&1) || true
  claude --version > "$out/version.txt"
}

# One turn with no task: enough to read how the setup splits into cache reads and cache writes.
probe_setup() {
  local work="$1" out="$2"
  shift 2
  mkdir -p "$out"
  (cd "$work" && "${clean_env[@]}" claude -p "Reply with the single word: ok" \
    "$@" \
    "${session_flags[@]}" \
    --max-turns 1 \
    < /dev/null 2> /dev/null) \
    | grep '^{' \
    | jq -c 'select(.type == "assistant") | .message.usage | {read: .cache_read_input_tokens, stored: .cache_creation_input_tokens, input: .input_tokens}' \
    | head -1 > "$out/turn1.json"
}
