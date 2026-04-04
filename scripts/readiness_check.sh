#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTAPI_BIN="${ROOT_DIR}/bin/agentapi"

print_kv() {
  local k="$1"
  local v="$2"
  printf "%-28s %s\n" "${k}" "${v}"
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

is_set() {
  local v="${1:-}"
  [[ -n "${v//[[:space:]]/}" ]]
}

section() {
  echo
  echo "== $1 =="
}

exit_with_hint() {
  local msg="$1"
  echo
  echo "FAILED: ${msg}" >&2
  exit 1
}

echo "Meridian readiness check"
echo "root: ${ROOT_DIR}"
echo "time: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"

section "agentapi binary"
if [[ ! -e "${AGENTAPI_BIN}" ]]; then
  print_kv "bin/agentapi" "missing"
  exit_with_hint "Install agentapi first (see scripts/install-agentapi.sh)."
fi
if [[ ! -x "${AGENTAPI_BIN}" ]]; then
  print_kv "bin/agentapi" "not executable"
  exit_with_hint "bin/agentapi exists but is not executable."
fi
print_kv "bin/agentapi" "present+executable"
"${AGENTAPI_BIN}" --help >/dev/null 2>&1 && print_kv "agentapi --help" "ok" || exit_with_hint "agentapi --help failed"

section "required utilities"
for util in curl tmux; do
  if has_cmd "${util}"; then
    print_kv "${util}" "present"
  else
    print_kv "${util}" "missing"
  fi
done

section "provider CLIs"
for provider in codex claude gemini cursor; do
  # Keep this bash-3.2 compatible (no associative arrays).
  case "${provider}" in
    codex) cmd="codex" ;;
    claude) cmd="claude" ;;
    gemini) cmd="gemini" ;;
    cursor) cmd="cursor" ;;
    *) cmd="" ;;
  esac
  if has_cmd "${cmd}"; then
    print_kv "${cmd}" "present"
  else
    print_kv "${cmd}" "missing"
  fi
done

section "provider credentials (env only; values not printed)"
print_kv "ANTHROPIC_API_KEY" "$(is_set "${ANTHROPIC_API_KEY:-}" && echo set || echo unset)"
print_kv "OPENAI_API_KEY"    "$(is_set "${OPENAI_API_KEY:-}" && echo set || echo unset)"
print_kv "GEMINI_API_KEY"    "$(is_set "${GEMINI_API_KEY:-}" && echo set || echo unset)"
print_kv "CURSOR_API_KEY"    "$(is_set "${CURSOR_API_KEY:-}" && echo set || echo unset)"

section "auth/login status (best-effort, non-fatal)"
if has_cmd codex; then
  if codex login status >/dev/null 2>&1; then
    print_kv "codex login status" "logged-in"
  else
    print_kv "codex login status" "not logged-in/failed"
  fi
fi
if has_cmd claude; then
  if claude auth status 2>/dev/null | grep -q '"loggedIn"[[:space:]]*:[[:space:]]*true'; then
    print_kv "claude auth status" "logged-in"
  else
    print_kv "claude auth status" "not logged-in/failed"
  fi
fi

section "codex app-server capability (best-effort)"
if has_cmd codex; then
  if codex app-server --help 2>/dev/null | grep -q "generate-ts"; then
    print_kv "codex app-server" "present (subcommands: generate-ts/generate-json-schema)"
    print_kv "models listing" "not supported by this codex version"
  else
    print_kv "codex app-server" "unknown/unsupported"
  fi
else
  print_kv "codex app-server" "codex CLI missing"
fi

echo
echo "DONE: readiness check completed."

