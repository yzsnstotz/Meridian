#!/usr/bin/env bash

# Meridian auto-install: prompt for crucial settings at the beginning, then
# npm install and create .env. Run from Meridian repo root, e.g.:
#   git clone https://github.com/yzsnstotz/Meridian.git && cd Meridian && ./user_scripts/install_Meridian/macos_install/install.sh
#
# Usage: ./user_scripts/install_Meridian/macos_install/install.sh
# Paths are relative to this script; repo root = ../../..

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_EXAMPLE="${ROOT_DIR}/.env.example"
ENV_FILE="${ROOT_DIR}/.env"

echo "=== Meridian installer ==="
echo "Repository root: ${ROOT_DIR}"
echo ""

# --- Prereqs ---
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required. Install from https://nodejs.org (engine ^22.0.0)." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required." >&2
  exit 1
fi
NODE_VER="$(node -p 'process.versions.node')"
echo "Node version: ${NODE_VER}"

if [[ ! -f "${ENV_EXAMPLE}" ]]; then
  echo "Error: .env.example not found. Run this script from the Meridian repo (keep user_scripts/install_Meridian/ structure)." >&2
  exit 1
fi

# --- Collect crucial info at the beginning ---
echo ""
echo "--- Required ---"

read -r -p "Telegram Bot Token (from @BotFather /newbot): " TELEGRAM_BOT_TOKEN
while [[ -z "${TELEGRAM_BOT_TOKEN}" ]] || [[ "${TELEGRAM_BOT_TOKEN}" == *"replace_with_real"* ]]; do
  echo "Token is required and must not be the placeholder."
  read -r -p "Telegram Bot Token: " TELEGRAM_BOT_TOKEN
done

read -r -p "Allowed Telegram User ID(s), comma-separated (e.g. from @userinfobot): " ALLOWED_USER_IDS
while [[ -z "${ALLOWED_USER_IDS}" ]]; do
  echo "At least one user ID is required."
  read -r -p "Allowed User ID(s): " ALLOWED_USER_IDS
done

echo ""
echo "--- Optional (press Enter to keep defaults) ---"

read -r -p "Extra Telegram bot tokens, comma-separated [none]: " TELEGRAM_BOT_TOKENS
TELEGRAM_BOT_TOKENS="${TELEGRAM_BOT_TOKENS:-}"

read -r -p "NODE_ENV (development|test|production) [development]: " NODE_ENV
NODE_ENV="${NODE_ENV:-development}"

read -r -p "LOG_LEVEL (trace|debug|info|warn|error|fatal) [debug]: " LOG_LEVEL
LOG_LEVEL="${LOG_LEVEL:-debug}"

read -r -p "AGENT_WORKDIR for /spawn default dir [empty]: " AGENT_WORKDIR
AGENT_WORKDIR="${AGENT_WORKDIR:-}"

echo ""
echo "--- Installing dependencies ---"
(cd "${ROOT_DIR}" && npm install)

echo ""
echo "--- Creating .env ---"

overwrite_env() {
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ "${line}" =~ ^TELEGRAM_BOT_TOKEN= ]]; then
      echo "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}"
    elif [[ "${line}" =~ ^TELEGRAM_BOT_TOKENS= ]]; then
      echo "TELEGRAM_BOT_TOKENS=${TELEGRAM_BOT_TOKENS}"
    elif [[ "${line}" =~ ^ALLOWED_USER_IDS= ]]; then
      echo "ALLOWED_USER_IDS=${ALLOWED_USER_IDS}"
    elif [[ "${line}" =~ ^NODE_ENV= ]]; then
      echo "NODE_ENV=${NODE_ENV}"
    elif [[ "${line}" =~ ^LOG_LEVEL= ]]; then
      echo "LOG_LEVEL=${LOG_LEVEL}"
    elif [[ "${line}" =~ ^AGENT_WORKDIR= ]]; then
      echo "AGENT_WORKDIR=${AGENT_WORKDIR}"
    else
      echo "${line}"
    fi
  done < "${ENV_EXAMPLE}" > "${ENV_FILE}.new"
  mv "${ENV_FILE}.new" "${ENV_FILE}"
  echo "Created ${ENV_FILE}"
}

if [[ -f "${ENV_FILE}" ]]; then
  read -r -p ".env already exists. Overwrite? (y/N): " OVERWRITE
  if [[ "${OVERWRITE}" != "y" && "${OVERWRITE}" != "Y" ]]; then
    echo "Skipping .env creation. Edit .env manually if needed."
  else
    overwrite_env
  fi
else
  overwrite_env
fi

echo ""
echo "=== Install complete ==="
echo ""
echo "Next steps:"
echo "  1. Configure slash commands in Telegram @BotFather: /setcommands"
echo "     (See README for the command list.)"
echo "  2. Start Meridian:"
echo "     macOS: double-click user_scripts/install_Meridian/macos_install/meridian-start.command"
echo "     Windows: double-click user_scripts/install_Meridian/windows_install/meridian-start.bat"
echo "     Or from terminal: npm run start:hub & npm run start:interface & npm run start:monitor"
echo ""
