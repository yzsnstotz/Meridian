---
name: meridian-roles-install
description: Install and verify the Meridian-roles CLI so an external agent can inspect dispatch state, recover workers, and start dispatch sessions through a running Meridian hub.
---

# Meridian-roles CLI Install

Use this skill when an external agent needs a self-contained setup path for the `meridian-roles` command.

## Prerequisites

- Node.js 20+ (`node -v`)
- npm (`npm -v`)
- Local checkout of `/Users/yzliu/work/Meridian/Meridian-roles`
- Local checkout of `/Users/yzliu/work/Meridian` because Meridian-roles depends on the Meridian hub for worker spawn/run/kill flows
- Meridian env file at `/Users/yzliu/work/Meridian/.env`
- Writable state file path for local development, for example `/tmp/meridian-roles/state.json`

Recommended values to verify before starting services:
- `HUB_SOCKET_PATH`
- `GUI_PORT`
- `ROLES_SOCKET_PATH`
- `STATE_FILE_PATH`
- `MERIDIAN_ROLES_HTTP` if you want the CLI to target a non-default host or port

## Install

```bash
cd /Users/yzliu/work/Meridian/Meridian-roles
npm install
npm run build
npm link
```

Alternative global install flow:

```bash
cd /Users/yzliu/work/Meridian/Meridian-roles
npm install
npm run build
npm install -g .
```

Default recommendation: use `npm link` for local development on this branch.

## Service Setup

Meridian-roles is not standalone for execution. The roles service must be running, and Meridian hub must also be running because dispatch worker execution and hub-backed tools call Meridian over `HUB_SOCKET_PATH`.

Start Meridian hub:

```bash
cd /Users/yzliu/work/Meridian
npm run start:hub
```

Optional Meridian web API / GUI:

```bash
cd /Users/yzliu/work/Meridian
npm run start:web
```

Start Meridian-roles:

```bash
cd /Users/yzliu/work/Meridian/Meridian-roles
npm start
```

## Environment

Meridian-roles loads `.env` and `.env.local` from its repo root. A practical local setup is:

```bash
export HUB_SOCKET_PATH=/tmp/hub-socks/hub-core.sock
export GUI_PORT=7701
export MERIDIAN_ROLES_HTTP=http://127.0.0.1:7701
export ROLES_SOCKET_PATH=/tmp/meridian-roles.sock
export STATE_FILE_PATH=/tmp/meridian-roles/state.json
```

Optional notify configuration:

```bash
export MERIDIAN_REPLY_CHANNEL='{"channel":"web","chat_id":"web:ops"}'
```

If you need multiple reply targets:

```bash
export MERIDIAN_REPLY_CHANNELS='[{"channel":"web","chat_id":"web:ops"},{"channel":"telegram","chat_id":"123"}]'
```

## Quick Reference

```bash
meridian-roles --help
meridian-roles health
meridian-roles list-roles
meridian-roles dispatch-status --plan /abs/path/dispatch_plan.md
meridian-roles dispatch-start --plan /abs/path/dispatch_plan.md --model-map 'CODEX=codex:gpt-5.4,OPUS=claude:claude-opus-4-6'
meridian-roles resume-worker --plan /abs/path/dispatch_plan.md --worker N-07 --action retry
meridian-roles spawn --agent-type codex --model-id gpt-5.4 --spawn-dir /Users/yzliu/work/Meridian --auto-approve true
meridian-roles kill --thread-id codex_01
```

## Common Operations

Check the installed binary:

```bash
meridian-roles --help
```

Check the local Meridian-roles service:

```bash
meridian-roles health
```

Inspect active roles:

```bash
meridian-roles list-roles
```

Inspect dispatch progress and stale workers:

```bash
meridian-roles dispatch-status --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md
meridian-roles dispatch-status --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md --stale-threshold 45
```

Start a dispatch with inline provider/model overrides:

```bash
meridian-roles dispatch-start --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md --model-map 'CODEX=codex:gpt-5.4,CODEX-XHIGH=codex:gpt-5.4,OPUS=claude:claude-opus-4-6'
```

Start a dispatch with a JSON override file:

```bash
cat >/tmp/model-map.json <<'EOF'
{
  "CODEX": { "provider": "codex", "model_id": "gpt-5.4" },
  "OPUS": { "provider": "claude", "model_id": "claude-opus-4-6" }
}
EOF

meridian-roles dispatch-start --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md --model-map-file /tmp/model-map.json
```

Recover a stuck worker:

```bash
meridian-roles resume-worker --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md --worker N-07 --action retry
meridian-roles resume-worker --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md --worker N-07 --action skip
meridian-roles resume-worker --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md --worker N-07 --action force-complete --force true
```

Send an operator notification:

```bash
meridian-roles notify --message "Dispatch completed" --urgency high
```

## Verification

Verify the binary is installed:

```bash
meridian-roles --help
```

Verify the local roles service is reachable:

```bash
meridian-roles health
```

Verify the dispatch tooling can read a plan:

```bash
meridian-roles dispatch-status --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md
```

If the local Meridian-roles HTTP API is unreachable, service-backed commands should return JSON with `ok: false` and exit code `3`.

## Troubleshooting

- If `meridian-roles` is not found, rerun `npm link` or `npm install -g .`.
- If `health`, `list-roles`, or `dispatch-start` return exit code `3`, verify the Meridian-roles service is running and `MERIDIAN_ROLES_HTTP` matches the service URL.
- If `spawn`, `run`, `kill`, or dispatch execution fails, verify Meridian hub is running and `HUB_SOCKET_PATH` points at the same socket used by Meridian.
- If `resume-worker --action force-complete` fails, add `--force true`.
- If `notify` fails, provide `--reply-channel` or `--reply-channels`, or export `MERIDIAN_REPLY_CHANNEL` / `MERIDIAN_REPLY_CHANNELS`.

## Notes

- `dispatch-start` expects `agent_dispatch_command.md` to live next to the target `dispatch_plan.md`.
- `dispatch-status` marks stale workers after 30 minutes by default; override with `--stale-threshold <minutes>` when needed.
- Parse stdout as the stable machine interface. Treat stderr as operator-facing help.
