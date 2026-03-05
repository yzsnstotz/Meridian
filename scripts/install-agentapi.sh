#!/usr/bin/env bash

set -euo pipefail

VERSION="${AGENTAPI_VERSION:-v0.11.2}"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "${OS}" in
linux|darwin)
  ;;
*)
  echo "Unsupported OS: ${OS}" >&2
  exit 1
  ;;
esac

ARCH="$(uname -m)"
case "${ARCH}" in
x86_64|amd64)
  ARCH="amd64"
  ;;
arm64|aarch64)
  ARCH="arm64"
  ;;
*)
  echo "Unsupported architecture: ${ARCH}" >&2
  exit 1
  ;;
esac

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${ROOT_DIR}/bin"
TARGET="${BIN_DIR}/agentapi"
ASSET_NAME="agentapi-${OS}-${ARCH}"
DOWNLOAD_URL="https://github.com/coder/agentapi/releases/download/${VERSION}/${ASSET_NAME}"

mkdir -p "${BIN_DIR}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "Downloading ${DOWNLOAD_URL}"
curl -fL "${DOWNLOAD_URL}" -o "${TMP_DIR}/agentapi"

install -m 0755 "${TMP_DIR}/agentapi" "${TARGET}"
echo "agentapi installed at ${TARGET}"
