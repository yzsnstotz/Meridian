#!/usr/bin/env bash

# Prune ~/.local/state/fnm_multishells/ before it hits the 65535 link-count cap.
#
# Every codex/agentapi spawn through fnm creates a new multishell entry.
# A storm of respawns (cf. learnings/storm-recurrence-architectural-root-cause.md
# and learnings/maintenance-hub-restart-pm2-and-socket-race.md PR #88) can
# saturate the directory; once link count hits 65535, `ls` takes 10+s and every
# new terminal hangs because shell init runs `eval "$(fnm env)"` which walks the
# directory. Symptom: 30s terminal spawn on macOS.
#
# Strategy: O(1) atomic rename, preserve the caller's $FNM_MULTISHELL_PATH if
# the script is invoked from an interactive shell, background the actual rm.
# The script self-skips when the directory size is under threshold, so it is
# safe to run on an hourly launchd cadence.
#
# Usage:
#   ./user_scripts/clean_fnm_multishells.sh                 # auto-skip if small
#   FNM_MULTISHELLS_THRESHOLD_BYTES=524288 ./user_scripts/clean_fnm_multishells.sh
#   FNM_MULTISHELLS_FORCE=1 ./user_scripts/clean_fnm_multishells.sh   # ignore threshold

set -euo pipefail

MULTISHELLS_DIR="${FNM_MULTISHELLS_DIR:-${HOME}/.local/state/fnm_multishells}"
THRESHOLD_BYTES="${FNM_MULTISHELLS_THRESHOLD_BYTES:-1048576}"  # 1 MB block-size
FORCE="${FNM_MULTISHELLS_FORCE:-0}"

TS=$(date +%s)
LOG_DIR="${FNM_MULTISHELLS_LOG_DIR:-/tmp}"
LOG="${LOG_DIR}/fnm-multishells-clean.log"

log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

if [ ! -d "$MULTISHELLS_DIR" ]; then
  log "no dir at $MULTISHELLS_DIR; nothing to do"
  exit 0
fi

# `stat -f '%z'` on macOS / `stat -c '%s'` on Linux. Both return the directory
# inode's block size — a fast syscall that does NOT enumerate entries (a
# 65535-entry enumerate would defeat the purpose of running this script).
if SIZE=$(stat -f '%z' "$MULTISHELLS_DIR" 2>/dev/null); then
  :
elif SIZE=$(stat -c '%s' "$MULTISHELLS_DIR" 2>/dev/null); then
  :
else
  SIZE=0
fi

if [ "$FORCE" != "1" ] && [ "$SIZE" -lt "$THRESHOLD_BYTES" ]; then
  log "size=$SIZE under threshold=$THRESHOLD_BYTES; skipping"
  exit 0
fi

OLD="${MULTISHELLS_DIR}.OLD.${TS}"
log "size=$SIZE >= threshold=$THRESHOLD_BYTES; rotating to $OLD"

# Atomic rename. Both paths are on the same filesystem so this is a single
# rename(2) syscall — does NOT enumerate, completes instantly.
mv "$MULTISHELLS_DIR" "$OLD"
mkdir -p "$MULTISHELLS_DIR"

# If the caller is an interactive shell, its $FNM_MULTISHELL_PATH points into
# the OLD directory now. Move that one entry back so the caller's existing PATH
# entry resolves. Other shells whose $FNM_MULTISHELL_PATH is also inside OLD
# will lose their PATH on next exec; they need to start a new shell. This is
# the unavoidable cost of clearing the saturation; it is rare in practice
# because most stale entries belong to long-exited shells.
if [ -n "${FNM_MULTISHELL_PATH:-}" ]; then
  CUR_NAME=$(basename "$FNM_MULTISHELL_PATH")
  if [ -e "$OLD/$CUR_NAME" ]; then
    mv "$OLD/$CUR_NAME" "$MULTISHELLS_DIR/$CUR_NAME"
    log "preserved current shell entry $CUR_NAME"
  fi
fi

# Background the actual rm. With 65535 entries × a few inner files each, the
# delete itself takes 30–60s on APFS — we don't want launchd to block on that.
# nohup + & + disown survives this script's exit.
(nohup rm -rf "$OLD" >>"$LOG" 2>&1) &
BG_PID=$!
disown "$BG_PID" 2>/dev/null || true
log "background rm started for $OLD (pid=$BG_PID)"
