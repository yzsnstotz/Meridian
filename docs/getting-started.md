# Getting started

This guide takes Meridian from a clean checkout to a managed Codex worker and
an explicit two-step dispatcher. It uses the native supervisor introduced by
the monorepo workspace.

## 1. Prerequisites

- macOS or Linux
- Node.js 22.13 or newer and npm
- At least one supported provider CLI installed and authenticated

Meridian can manage Codex, Claude, Gemini, and Cursor workers. You only need one
provider for the first run.

## 2. Install the workspace

```bash
git clone https://github.com/yzsnstotz/Meridian.git
cd Meridian

npm ci
npm run build
npm link --workspace @meridian/cli
```

The link makes the `meridian` command available from your current npm prefix.
Rerun the build after changing TypeScript sources.

## 3. Create a local configuration

Meridian uses private per-user platform directories by default. Setting an
explicit config directory makes a development installation easy to inspect and
move:

```bash
export MERIDIAN_CONFIG_DIR="$HOME/.config/meridian"
mkdir -p "$MERIDIAN_CONFIG_DIR"
cp .env.example "$MERIDIAN_CONFIG_DIR/.env"
chmod 600 "$MERIDIAN_CONFIG_DIR/.env"
```

Edit these required values:

```dotenv
TELEGRAM_BOT_TOKEN=123456789:replace_with_real_token
ALLOWED_USER_IDS=123456789
```

Syntactically valid placeholders are enough to evaluate the local Web UI and
CLI. Use a real BotFather token and your numeric Telegram user ID before
starting the Telegram interface.

All path overrides must be absolute. If they are unset, Meridian selects
portable platform defaults:

| Data | macOS | Linux |
| --- | --- | --- |
| Config | `~/Library/Application Support/Meridian/config` | `${XDG_CONFIG_HOME:-~/.config}/meridian` |
| Data | `~/Library/Application Support/Meridian/data` | `${XDG_DATA_HOME:-~/.local/share}/meridian` |
| State and logs | `~/Library/Application Support/Meridian/state` | `${XDG_STATE_HOME:-~/.local/state}/meridian` |
| Runtime sockets | System temporary directory | `${XDG_RUNTIME_DIR:-system temporary directory}` |

## 4. Start the product

```bash
meridian start
meridian doctor
meridian service list
```

`meridian start` launches Runtime and Orchestrator, waits for authenticated
readiness, and records native service descriptors. It does not start the
optional Gateway.

Open the two operator surfaces. Read the generated `WEB_GUI_TOKEN` from the
private config `.env` and use it only in the loopback Runtime URL:

- Runtime Console: `http://127.0.0.1:3000/?token=<WEB_GUI_TOKEN>`
- Orchestrator Dashboard: `http://127.0.0.1:7701`

The supervisor generates private bootstrap and Web tokens on first launch.
Keep the generated config directory private.

## 5. Launch a Codex worker

Make sure the Codex CLI is already authenticated, then run:

```bash
meridian models codex
meridian spawn codex --workdir "$PWD" --mode bridge
meridian status --agents
```

Copy the returned thread ID and send the first instruction:

```bash
meridian send <thread-id> "Inspect this repository and summarize its architecture."
meridian logs <thread-id>
```

Meridian keeps the provider process, thread identity, logs, and routing state
under Runtime ownership. You can continue the same worker with additional
`meridian send` calls.

## 6. Create an explicit task graph

The smallest orchestration example is a `dispatcher` role with two dependent
tasks:

```bash
curl -X POST http://127.0.0.1:7701/api/role \
  -H 'Content-Type: application/json' \
  -d '{
    "thread_id": "getting-started-dispatcher",
    "role_type": "dispatcher",
    "tasks": [
      {
        "task_id": "inspect",
        "instruction": "Inspect the repository structure and identify the main packages.",
        "depends_on": []
      },
      {
        "task_id": "summarize",
        "instruction": "Produce a concise architecture summary using the inspection result.",
        "depends_on": ["inspect"]
      }
    ]
  }'
```

Open the Orchestrator Dashboard to inspect role and task state. For durable
project execution, use an `agent-dispatcher` with a checked-in TaskSpec and
dispatch plan; the [system index](system/SYSTEM_INDEX.md) routes to the detailed
orchestration modules.

## 7. Stop cleanly

```bash
meridian stop
meridian status
```

Stopping the supervisor removes live service registrations while preserving
durable state for the next launch.

## Troubleshooting

### `meridian` is not found

Run `npm link --workspace @meridian/cli` again and confirm the npm global binary
directory is on `PATH`.

### Configuration validation fails

Confirm `MERIDIAN_CONFIG_DIR` points to the directory containing `.env`, required
Telegram/operator fields are present, and every configured Meridian path is
absolute.

### A service is not ready

```bash
meridian doctor
meridian service doctor
```

Then inspect the resolved state log directory. The
[operations guide](operations.md) explains ports, locations, logs, and safe
recovery.

### The provider cannot be launched

Confirm its CLI is installed and authenticated in the same user environment
that started Meridian. Use `meridian runtime catalog` to inspect visible
providers, accounts, and models.
