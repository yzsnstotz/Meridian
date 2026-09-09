#!/usr/bin/env bash

# Source-only preflight. Do not stop services unless the selected runtime can
# load the installed native queue-lock module. PM2's own installation is not
# evidence of the Node version used to install this repository's dependencies.
prepare_meridian_node() {
  local meridian_root="$1"
  local candidate="${MERIDIAN_NODE_INTERPRETER:-}"
  if [[ -z "${candidate}" ]]; then
    candidate="$(command -v node || true)"
  fi
  if [[ -z "${candidate}" || ! -x "${candidate}" ]]; then
    echo "No executable Meridian Node runtime; set MERIDIAN_NODE_INTERPRETER to the dependency-install Node." >&2
    return 1
  fi
  local resolved
  if ! resolved="$("${candidate}" -e 'require(require("node:path").join(process.argv[1], "node_modules/fs-ext")); process.stdout.write(process.execPath)' "${meridian_root}")"; then
    echo "Meridian Node/native-module preflight failed; existing services were not stopped. Use the Node that installed fs-ext." >&2
    return 1
  fi
  MERIDIAN_NODE_INTERPRETER="${resolved}"
  export MERIDIAN_NODE_INTERPRETER
  # npm and PM2 have env-node shebangs; keep build and service launch consistent.
  export PATH="$(dirname "${MERIDIAN_NODE_INTERPRETER}"):${PATH}"
}
