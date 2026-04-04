---
name: meridian-install
description: Install and verify the Meridian CLI so an external agent can call the hub through the `meridian` command.
---

# Meridian CLI Install

Use this skill when an external agent needs a self-contained setup path for the Meridian CLI.

## Prerequisites

- Node.js 20+ (`node -v`)
- npm (`npm -v`)
- Local checkout of `/Users/yzliu/work/Meridian`
- Meridian service env file at `/Users/yzliu/work/Meridian/.env`

Minimum env values to verify:
- `HUB_SOCKET_PATH`
- `WEB_GUI_PORT`
- `WEB_GUI_HOST` when the web GUI is exposed externally
- `TELEGRAM_BOT_TOKEN` if Telegram flows are in use

## Install

```bash
cd /Users/yzliu/work/Meridian
npm install
npm run build
npm link
```

Alternative global install flow:

```bash
cd /Users/yzliu/work/Meridian
npm install
npm run build
npm install -g .
```

Default recommendation: use `npm link` for local development on this branch.

## Service Setup

The CLI expects a running Meridian service. In this repo, start the hub and web server from the project root:

```bash
cd /Users/yzliu/work/Meridian
npm run start:hub
```

Optional web API / GUI process:

```bash
cd /Users/yzliu/work/Meridian
npm run start:web
```

## CLI Environment

The CLI resolves service discovery from these variables:

| Variable | Default | Use |
|----------|---------|-----|
| `MERIDIAN_SOCKET` | `/tmp/hub-core.sock` | Socket fallback |
| `MERIDIAN_HTTP` | `http://localhost:3000` | HTTP endpoint |
| `AGENT_WORKDIR` | parent of repo root | Default spawn workdir |

Example override:

```bash
export MERIDIAN_HTTP=http://localhost:3000
export MERIDIAN_SOCKET=/tmp/hub-core.sock
```

## Quick Reference

```bash
meridian --help
meridian status
meridian health
meridian spawn codex --model gpt-5.4 --workdir /Users/yzliu/work/Meridian --auto-approve
meridian send codex_01 "Continue the task."
meridian logs codex_01
meridian autoapprove status
meridian kill codex_01
```

## Common Operations

Spawn a Codex worker:

```bash
meridian spawn codex --model gpt-5.4 --workdir /Users/yzliu/work/Meridian --auto-approve
```

Spawn a Claude worker with manual approvals:

```bash
meridian spawn claude --model claude-opus-4-6 --workdir /Users/yzliu/work/project --no-auto-approve
```

Inspect running instances:

```bash
meridian status
```

Send a follow-up instruction:

```bash
meridian send codex_01 "Check the latest failing command and fix it."
```

Read thread logs:

```bash
meridian logs codex_01
```

## Verification

Check that the binary is installed:

```bash
meridian --help
```

Check service reachability:

```bash
meridian health
```

If the service is unreachable, Meridian CLI should exit with code `3` and return JSON with `ok: false`.

## Troubleshooting

- If `meridian` is not found, rerun `npm link` or `npm install -g .`.
- If `meridian health` reports the service as unreachable, verify the hub is running and `MERIDIAN_HTTP` / `MERIDIAN_SOCKET` match the service configuration.
- If spawn fails with a workdir validation error, use a path under `AGENT_WORKDIR`.
- Treat stdout as the machine interface. Parse stderr only for interactive troubleshooting.

## Branch Note

This skill documents the CLI contract for `feat-cli-external-integration`. If runtime commands still return `not implemented`, the install/link steps are valid but end-to-end command execution is blocked by incomplete CLI command handlers in the current checkout.
