#!/bin/bash
# Credential preflight for the peak-task image (Cairn-style startup
# healthcheck): every backend the task actually uses (PEAK_PREFLIGHT_BACKENDS,
# comma-separated worker types) must show an auth signal BEFORE the task
# starts, so missing credentials fail fast here instead of surfacing as a
# worker timeout mid-run. See container/AUTH.md for the full injection matrix.
#
# Auth signals per backend:
#   1. an explicit per-worker `env` key in the mounted /board/task.json
#      (the recommended, fully explicit path — Peak never scans host env);
#   2. a container env var (only if the user injected one themselves);
#   3. a mounted login-state directory (read-only, e.g. ~/.claude -> /root/.claude).
set -euo pipefail

missing=0

has_env() { [ -n "${!1:-}" ]; }
has_dir() { [ -d "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null || true)" ]; }

# Env key names explicitly configured on workers in the mounted Board config.
TASK_ENV_KEYS=""
if [ -f /board/task.json ]; then
  TASK_ENV_KEYS="$(node -e '
    const fs = require("fs");
    const config = JSON.parse(fs.readFileSync("/board/task.json", "utf8"));
    const keys = new Set();
    for (const worker of config.workers || []) for (const key of Object.keys(worker.env || {})) keys.add(key);
    process.stdout.write([...keys].join(" "));
  ' 2>/dev/null || true)"
fi
has_task_env() { case " $TASK_ENV_KEYS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

check() {
  local name="$1" cli="$2" hint="$3"
  shift 3
  if ! command -v "$cli" >/dev/null 2>&1; then
    echo "[preflight] $name: CLI '$cli' is not installed in this image"
    missing=1
    return
  fi
  local signal key
  for signal in "$@"; do
    case "$signal" in
      env:*)
        key="${signal#env:}"
        if has_env "$key"; then echo "[preflight] $name: ok ($key)"; return; fi
        if has_task_env "$key"; then echo "[preflight] $name: ok (task.json worker env $key)"; return; fi
        ;;
      dir:*) if has_dir "${signal#dir:}"; then echo "[preflight] $name: ok (${signal#dir:})"; return; fi ;;
    esac
  done
  echo "[preflight] $name: MISSING credentials — $hint"
  missing=1
}

for backend in ${PEAK_PREFLIGHT_BACKENDS//,/ }; do
  case "$backend" in
    claude-code) check "claude-code" "claude" "set ANTHROPIC_API_KEY in the worker env of task.json, or mount ~/.claude" \
      env:ANTHROPIC_API_KEY dir:/root/.claude ;;
    codex) check "codex" "codex" "set OPENAI_API_KEY in the worker env of task.json, or mount ~/.codex" \
      env:OPENAI_API_KEY dir:/root/.codex ;;
    opencode) check "opencode" "opencode" "set a provider key in the worker env of task.json, or mount ~/.local/share/opencode" \
      env:ANTHROPIC_API_KEY env:OPENAI_API_KEY env:OPENROUTER_API_KEY env:DEEPSEEK_API_KEY env:GOOGLE_API_KEY \
      dir:/root/.local/share/opencode ;;
    pi) check "pi" "pi" "set a provider key in the worker env of task.json (see container/AUTH.md), or mount ~/.pi" \
      env:ANTHROPIC_API_KEY env:OPENAI_API_KEY env:OPENROUTER_API_KEY env:DEEPSEEK_API_KEY env:GOOGLE_API_KEY \
      dir:/root/.pi ;;
    *) echo "[preflight] unknown backend: $backend" ;;
  esac
done

if [ "$missing" -ne 0 ]; then
  echo "[preflight] failed; task not started" >&2
  exit 1
fi

exec peak "$@"
