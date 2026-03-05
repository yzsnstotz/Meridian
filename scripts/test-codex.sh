#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTAPI_BIN="${ROOT_DIR}/bin/agentapi"
CODEX_BIN="${CODEX_BIN:-codex}"
PROMPT="${CODEX_TEST_PROMPT:-Reply with a single sentence that starts with T08_Codex_OK.}"
STARTUP_TIMEOUT_SEC="${CODEX_STARTUP_TIMEOUT_SEC:-20}"
RESPONSE_TIMEOUT_SEC="${CODEX_RESPONSE_TIMEOUT_SEC:-240}"
TEST_WORKDIR="${CODEX_TEST_WORKDIR:-${ROOT_DIR}}"
RUN_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

if [[ ! -x "${AGENTAPI_BIN}" ]]; then
  echo "Missing executable agentapi binary: ${AGENTAPI_BIN}" >&2
  exit 1
fi

if ! command -v "${CODEX_BIN}" >/dev/null 2>&1; then
  echo "Missing codex CLI in PATH: ${CODEX_BIN}" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for test-codex.sh" >&2
  exit 1
fi

has_codex_login() {
  codex login status >/dev/null 2>&1
}

if [[ -z "${OPENAI_API_KEY:-}" ]] && ! has_codex_login; then
  echo "No Codex auth detected. Set OPENAI_API_KEY or run: codex login" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "/tmp/meridian-t08-codex.XXXXXX")"
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
    local status_payload
    if status_payload="$(curl --silent --show-error --fail "${base_url}/status" 2>/dev/null)"; then
      if grep -Eiq '"status"[[:space:]]*:[[:space:]]*"stable"' <<<"${status_payload}"; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

wait_for_marker() {
  local base_url="$1"
  local marker="$2"
  local deadline=$((SECONDS + RESPONSE_TIMEOUT_SEC))
  while ((SECONDS < deadline)); do
    local messages status_payload
    messages="$(curl --silent --show-error --fail "${base_url}/messages" 2>/dev/null || true)"
    status_payload="$(curl --silent --show-error --fail "${base_url}/status" 2>/dev/null || true)"

    if grep -Fq "${marker}" <<<"${messages}" &&
      grep -Eiq '"role"[[:space:]]*:[[:space:]]*"agent"' <<<"${messages}" &&
      grep -Eiq '"status"[[:space:]]*:[[:space:]]*"stable"' <<<"${status_payload}"; then
      printf "%s\n" "${messages}"
      return 0
    fi

    sleep 2
  done
  return 1
}

run_mode() {
  local mode="$1"
  local thread_id="codex_t08_${mode}_$(date +%s)"
  local agent_log="${TMP_DIR}/${thread_id}.agentapi.log"
  local mode_result="${TMP_DIR}/${thread_id}.message.json"
  local message_dump="${TMP_DIR}/${thread_id}.messages.json"
  local session=""
  local port
  port="$(pick_port)"
  local base_url="http://127.0.0.1:${port}"
  local -a args=("server" "--type=codex" "--port=${port}" "--" "${CODEX_BIN}")
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

  local marker prompt payload
  marker="T08_Codex_OK_${mode}_$(date +%s)"
  prompt="${PROMPT} Respond with this exact marker: ${marker}"
  payload="{\"type\":\"user\",\"content\":\"$(escape_json "${prompt}")\"}"

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

  if ! grep -Eiq '"ok"[[:space:]]*:[[:space:]]*true' "${mode_result}"; then
    echo "POST /message did not return ok=true: mode=${mode}" >&2
    cat "${mode_result}" >&2
    return 1
  fi

  if ! wait_for_marker "${base_url}" "${marker}" >"${message_dump}"; then
    echo "Timed out waiting for agent marker response: mode=${mode}, marker=${marker}" >&2
    echo "agentapi log: ${agent_log}" >&2
    return 1
  fi

  if [[ "${mode}" == "pane_bridge" ]]; then
    if ! tmux has-session -t "${session}" 2>/dev/null; then
      echo "tmux session missing for pane_bridge mode: ${session}" >&2
      return 1
    fi
  fi

  local status_snapshot
  status_snapshot="$(curl --silent --show-error --fail "${base_url}/status")"
  printf "[PASS] mode=%s thread_id=%s marker=%s\nstatus=%s\nmessage_ack=%s\nmessages=%s\n\n" \
    "${mode}" "${thread_id}" "${marker}" "${status_snapshot}" "$(cat "${mode_result}")" "$(cat "${message_dump}")" | tee -a "${RESULT_FILE}"
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

echo "T-08 Codex E2E started at ${RUN_AT}"
for mode in "${MODES[@]}"; do
  run_mode "${mode}"
done

echo "T-08 Codex E2E completed. Result log: ${RESULT_FILE}"
