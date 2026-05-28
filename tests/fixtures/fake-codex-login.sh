#!/usr/bin/env bash
# Fake `codex login` used by OAuthLoginJob integration tests.
# Honors env vars (all optional):
#   FAKE_CODEX_URL           — URL to emit on stdout. Default: https://chatgpt.com/auth/test
#                              (in device mode, defaults to https://auth.openai.com/codex/device)
#   FAKE_CODEX_URL_DELAY_MS  — ms to wait before printing URL. Default: 0
#   FAKE_CODEX_DELAY_MS      — ms to wait before writing auth.json. Default: 200
#   FAKE_CODEX_FAIL          — if non-empty, exit 1 BEFORE writing auth.json
#   FAKE_CODEX_NO_URL        — if non-empty, skip printing the URL entirely
#   FAKE_CODEX_CODE          — user code to emit in device mode. Default: FAKE-CODE1
# Switches based on argv: if any argument is `--device-auth`, prints the
# device-code style banner (URL + user code) instead of a single URL.
# Writes auth.json into $CODEX_HOME (which must be set by the caller).

set -e

if [[ -z "${CODEX_HOME:-}" ]]; then
  echo "fake-codex-login: CODEX_HOME not set" >&2
  exit 2
fi

DEVICE_MODE=0
for arg in "$@"; do
  if [[ "$arg" == "--device-auth" ]]; then
    DEVICE_MODE=1
    break
  fi
done

if [[ "$DEVICE_MODE" -eq 1 ]]; then
  URL="${FAKE_CODEX_URL:-https://auth.openai.com/codex/device}"
else
  URL="${FAKE_CODEX_URL:-https://chatgpt.com/auth/test}"
fi
CODE="${FAKE_CODEX_CODE:-FAKE-CODE1}"
URL_DELAY_MS="${FAKE_CODEX_URL_DELAY_MS:-0}"
DELAY_MS="${FAKE_CODEX_DELAY_MS:-200}"

ms_to_s() { awk "BEGIN{printf \"%.3f\", $1 / 1000}"; }

if [[ "$URL_DELAY_MS" -gt 0 ]]; then
  sleep "$(ms_to_s "$URL_DELAY_MS")"
fi

if [[ -z "${FAKE_CODEX_NO_URL:-}" ]]; then
  if [[ "$DEVICE_MODE" -eq 1 ]]; then
    cat <<EOF
Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   $URL

2. Enter this one-time code (expires in 15 minutes)
   $CODE

Device codes are a common phishing target. Never share this code.
EOF
  elif [[ -n "${FAKE_CODEX_FRAGMENT_URL:-}" ]]; then
    # Emit the URL in two writes with no newline between them, to reproduce
    # the production failure mode where a `data` event chunk boundary fell
    # inside the URL string and the per-line extractor never saw a complete
    # URL on any single line.
    half=$(( ${#URL} / 2 ))
    printf "Open this URL: %s" "${URL:0:$half}"
    sleep 0.05
    printf "%s\n" "${URL:$half}"
  else
    echo "Open this URL to sign in: $URL"
  fi
fi

if [[ -n "${FAKE_CODEX_FAIL:-}" ]]; then
  echo "simulated failure" >&2
  exit 1
fi

sleep "$(ms_to_s "$DELAY_MS")"

cat > "$CODEX_HOME/auth.json" <<EOF
{"tokens":{"access_token":"fake","refresh_token":"fake"},"version":"1.0"}
EOF

echo "Logged in successfully"
