#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTAPI_BIN="${ROOT_DIR}/bin/agentapi"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
CLAUDE_ALLOWED_TOOLS="${CLAUDE_ALLOWED_TOOLS:-Bash Edit Replace}"
PROMPT="${CLAUDE_TEST_PROMPT:-list files in current directory}"
STARTUP_TIMEOUT_SEC="${CLAUDE_STARTUP_TIMEOUT_SEC:-20}"
TEST_WORKDIR="${CLAUDE_TEST_WORKDIR:-${ROOT_DIR}}"
RUN_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

if [[ ! -x "${AGENTAPI_BIN}" ]]; then
  echo "Missing executable agentapi binary: ${AGENTAPI_BIN}" >&2
  exit 1
fi

if ! command -v "${CLAUDE_BIN}" >/dev/null 2>&1; then
  echo "Missing claude CLI in PATH: ${CLAUDE_BIN}" >&2
  exit 1
fi

if ! "${CLAUDE_BIN}" --version >/dev/null 2>&1; then
  echo "Failed to execute claude CLI: ${CLAUDE_BIN} --version" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for test-claude.sh" >&2
  exit 1
fi

load_anthropic_key_from_env_file() {
  local env_file="${ROOT_DIR}/.env"
  if [[ -n "${ANTHROPIC_API_KEY:-}" || ! -f "${env_file}" ]]; then
    return
  fi

  local line
  line="$(grep -E '^ANTHROPIC_API_KEY=' "${env_file}" | tail -n 1 || true)"
  if [[ -z "${line}" ]]; then
    return
  fi

  local value="${line#ANTHROPIC_API_KEY=}"
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  if [[ -n "${value}" ]]; then
    export ANTHROPIC_API_KEY="${value}"
  fi
}

load_anthropic_key_from_env_file
has_claude_login() {
  "${CLAUDE_BIN}" auth status 2>/dev/null | grep -q '"loggedIn"[[:space:]]*:[[:space:]]*true'
}

if [[ -z "${ANTHROPIC_API_KEY:-}" ]] && ! has_claude_login; then
  echo "No Claude auth detected. Set ANTHROPIC_API_KEY, add it to .env, or run: claude auth login" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "/tmp/meridian-t07-claude.XXXXXX")"
RESULT_FILE="${TMP_DIR}/result.log"
PIDS=()
SESSIONS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "${pid}" >/dev/null 2>&1 || true
    wait "${pid}" >/dev/null 2>&1 || true
  done
  for session in "${SESSIONS[@]:-}"; do
    tmux kill-session -t "${session}" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

escape_json() {
  local raw="$1"
  raw="${raw//\\/\\\\}"
  raw="${raw//\"/\\\"}"
  printf "%s" "${raw}"
}

pick_port() {
  echo $((20000 + RANDOM % 20000))
}

wait_for_agentapi() {
  local base_url="$1"
  local deadline=$((SECONDS + STARTUP_TIMEOUT_SEC))
  while ((SECONDS < deadline)); do
    if curl --silent --show-error --fail "${base_url}/status" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

run_mode() {
  local mode="$1"
  local thread_id="claude_t07_${mode}_$(date +%s)"
  local agent_log="${TMP_DIR}/${thread_id}.agentapi.log"
  local mode_result="${TMP_DIR}/${thread_id}.message.json"
  local session=""
  local port
  port="$(pick_port)"
  local base_url="http://127.0.0.1:${port}"
  local -a args=("server" "--type=claude" "--port=${port}" "--" "${CLAUDE_BIN}" "--allowedTools" "${CLAUDE_ALLOWED_TOOLS}")
  local launcher="${TMP_DIR}/${thread_id}.run.sh"

  {
    echo "#!/usr/bin/env bash"
    echo "set -euo pipefail"
    printf 'cd %q\n' "${TEST_WORKDIR}"
    printf '%q ' "${AGENTAPI_BIN}" "${args[@]}"
    printf '> %q 2>&1\n' "${agent_log}"
  } >"${launcher}"
  chmod +x "${launcher}"

  if [[ "${mode}" == "pane_bridge" ]]; then
    if ! command -v tmux >/dev/null 2>&1; then
      echo "tmux is required for pane_bridge mode." >&2
      return 1
    fi
    session="agent_${thread_id}"
    tmux new-session -d -s "${session}" "${launcher}"
    SESSIONS+=("${session}")
  else
    "${launcher}" &
    local pid=$!
    PIDS+=("${pid}")
  fi

  if ! wait_for_agentapi "${base_url}"; then
    echo "Timed out waiting for agentapi startup: mode=${mode}, url=${base_url}" >&2
    echo "agentapi log: ${agent_log}" >&2
    return 1
  fi

  local payload
  payload="{\"content\":\"$(escape_json "${PROMPT}")\"}"

  if ! curl --silent --show-error --fail \
    -H "content-type: application/json" \
    -X POST "${base_url}/message" \
    --data "${payload}" >"${mode_result}"; then
    echo "POST /message failed: mode=${mode}" >&2
    echo "agentapi log: ${agent_log}" >&2
    return 1
  fi

  if [[ ! -s "${mode_result}" ]]; then
    echo "Empty response from POST /message: mode=${mode}" >&2
    return 1
  fi

  if grep -Eiq '"status"[[:space:]]*:[[:space:]]*"error"|"error"[[:space:]]*:' "${mode_result}"; then
    echo "Error response detected for mode=${mode}" >&2
    cat "${mode_result}" >&2
    return 1
  fi

  local pane_output=""
  if [[ "${mode}" == "pane_bridge" ]]; then
    if ! tmux has-session -t "${session}" 2>/dev/null; then
      echo "tmux session missing for pane_bridge mode: ${session}" >&2
      return 1
    fi

    pane_output="$(tmux capture-pane -pt "${session}" -S -200 2>/dev/null || true)"
    if [[ -z "${pane_output//[[:space:]]/}" ]]; then
      echo "tmux pane has no output for pane_bridge mode: ${session}" >&2
      echo "agentapi log: ${agent_log}" >&2
      return 1
    fi
  fi

  local status_snapshot
  status_snapshot="$(curl --silent --show-error --fail "${base_url}/status")"

  printf "[PASS] mode=%s thread_id=%s\nstatus=%s\nresponse=%s\n" \
    "${mode}" "${thread_id}" "${status_snapshot}" "$(cat "${mode_result}")" | tee -a "${RESULT_FILE}"

  if [[ "${mode}" == "pane_bridge" ]]; then
    printf "tmux_pane_output=%s\n" "${pane_output}" | tee -a "${RESULT_FILE}"
  fi

  printf "\n" | tee -a "${RESULT_FILE}"
}

MODES=()
if [[ $# -eq 0 ]]; then
  MODES=("bridge" "pane_bridge")
else
  for arg in "$@"; do
    case "${arg}" in
    bridge | pane_bridge) MODES+=("${arg}") ;;
    *)
      echo "Unsupported mode: ${arg} (expected: bridge or pane_bridge)" >&2
      exit 1
      ;;
    esac
  done
fi

echo "T-07 Claude E2E started at ${RUN_AT}"
for mode in "${MODES[@]}"; do
  run_mode "${mode}"
done

echo "T-07 Claude E2E completed. Result log: ${RESULT_FILE}"
