# Operations guide

The native `meridian` supervisor is the recommended way to run the monorepo. It
owns Runtime and Orchestrator as separate processes, waits for real readiness,
publishes service descriptors, and applies bounded restarts.

## Lifecycle

```bash
meridian start
meridian status
meridian doctor
meridian stop
```

Lifecycle commands do not depend on a reachable Runtime API. Use service
discovery when integrating another local process:

```bash
meridian service list
meridian service describe org.meridian/runtime
meridian service resolve org.meridian/orchestrator
meridian service doctor
```

The Gateway is intentionally independent and is never started or stopped by the
native supervisor.

## Ports and binding

| Service | Default | Override |
| --- | --- | --- |
| Runtime Web UI/API | `127.0.0.1:3000` | `WEB_GUI_HOST`, `WEB_GUI_PORT` |
| Orchestrator UI/API | `127.0.0.1:7701` | `GUI_LISTEN_HOST`, `GUI_PORT` |
| Gateway | `127.0.0.1:8789` | `MERIDIAN_GATEWAY_HOST`, `MERIDIAN_GATEWAY_PORT` |

Keep all services on loopback unless a trusted reverse proxy provides TLS and
access control. Changing a host to `0.0.0.0` is an exposure decision, not a
deployment shortcut.

## Filesystem ownership

Meridian resolves paths in this order:

1. An explicit programmatic override
2. A `MERIDIAN_*` environment variable
3. User configuration
4. A platform default

Frequently used overrides:

| Variable | Purpose |
| --- | --- |
| `MERIDIAN_CONFIG_DIR` | `.env` and private bootstrap material |
| `MERIDIAN_DATA_DIR` | Static service declarations and product data |
| `MERIDIAN_STATE_DIR` | Durable Hub, Orchestrator, supervisor, and credential state |
| `MERIDIAN_RUNTIME_DIR` | Ephemeral runtime descriptors |
| `MERIDIAN_LOG_DIR` | Runtime and Orchestrator logs |
| `MERIDIAN_SOCKET_DIR` | Local IPC sockets |
| `MERIDIAN_WORK_ROOT` | Default permitted workspace root |
| `MERIDIAN_TASKSPEC_ROOT` | Optional TaskSpec root |
| `MERIDIAN_DOCS_ROOT` | Optional project documentation root |

Overrides must be absolute. Meridian creates owned directories with private
permissions where the platform supports them.

## Logs and health

Start with structured diagnosis:

```bash
meridian doctor
meridian service doctor
```

The Runtime Console shows the active log footprint and retained files. For a
specific worker:

```bash
meridian logs <thread-id>
```

When investigating a restart, preserve the state and log directories. Deleting
socket files or state before reading `meridian doctor` can remove the evidence
needed to distinguish a stale descriptor from a live process.

## Telegram

Telegram is an optional operator surface. Configure a BotFather token and a
comma-separated allowlist of numeric user IDs:

```dotenv
TELEGRAM_BOT_TOKEN=123456789:real_bot_token
ALLOWED_USER_IDS=123456789,987654321
```

Start the interface separately from the native Runtime/Orchestrator supervisor:

```bash
npm run start:interface
```

Long polling is used when `WEBHOOK_URL` is empty. For webhook mode, configure
`WEBHOOK_URL`, `WEBHOOK_PORT`, and an optional `WEBHOOK_SECRET_TOKEN`. Multiple
bots can be supplied with `TELEGRAM_BOT_TOKENS`.

## Safe recovery sequence

1. Run `meridian status` and `meridian doctor`.
2. Record live PIDs, descriptors, and the relevant log tail.
3. Attempt `meridian stop` before terminating processes directly.
4. Confirm the configured ports and socket path are free.
5. Run `meridian start`, then `meridian service doctor`.

Do not remove state or credential directories as a first recovery step. They
contain durable thread ownership and account metadata.

## Updates

From a clean checkout:

```bash
git pull --ff-only
npm ci
npm run build
npm link --workspace @meridian/cli
meridian stop
meridian start
meridian doctor
```

Review release or branch notes before updating unattended installations. The
project is under active development and state migrations should be treated as
operational changes.
