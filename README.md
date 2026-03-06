# Meridian Phase 0

## Telegram Bot Registration (T-03)
1. Open `@BotFather` in Telegram and run `/newbot`.
1. Save the generated token and set `TELEGRAM_BOT_TOKEN` in `.env`.
1. Set your Telegram user id in `ALLOWED_USER_IDS`.
1. Optional: set `AGENT_WORKDIR` in `.env` to choose the default repo directory for `/spawn`.
1. Configure slash commands in `@BotFather` with `/setcommands`:

```text
spawn - Spawn a new agent instance
kill - Kill an existing instance
status - Get current instance status
attach - Attach this chat to a thread
update - Toggle monitor progress updates for a thread
mupdate - Send one manual progress update for a thread
list - List active instances
help - Show command usage
```

`/spawn` supports an optional directory argument:

```text
/spawn type=codex mode=pane_bridge dir=/absolute/path/to/repo
```

`/update` supports optional interval and explicit thread:

```text
/update on thread=codex_01 interval=30
/update off thread=codex_01
```

`/mupdate` sends one immediate progress snapshot without enabling periodic updates:

```text
/mupdate
/mupdate thread=codex_01
```

## Local Development
```bash
npm run start:hub
npm run start:interface
npm run start:monitor
```

## Deployment (T-11)

### Runtime Directory Structure
```text
/var/log/hub/
  hub.log
  hub-error.log
  interface.log
  interface-error.log
  monitor.log
  monitor-error.log
  instance.log
/tmp/hub-socks/
  hub-core.sock
```

### 1) Initialize Host Directories
```bash
sudo ./scripts/setup-host.sh
```

### 2) Build
```bash
npm run build
```

### 3) PM2 Process Guard
Start:
```bash
pm2 start ecosystem.config.js
```

Stop:
```bash
pm2 stop ecosystem.config.js
pm2 delete ecosystem.config.js
```

Logs:
```bash
pm2 logs
```

Notes:
- `calling-hub`, `calling-interface`, and `calling-monitor` are all started by default.
- `agentapi` child processes are not managed by PM2.
- `setup-host.sh` assigns log/socket directory ownership to the runtime user when run with `sudo`.

### 4) Docker Compose (Alternative)
Build image:
```bash
docker compose build
```

Start Hub + Interface:
```bash
docker compose up -d hub interface
```

Start Monitor (after monitor build artifact exists):
```bash
docker compose --profile monitor up -d monitor
```

Stop:
```bash
docker compose down
```

Tail logs:
```bash
docker compose logs -f
```

Notes:
- Unix socket directory is bind-mounted: `/tmp/hub-socks:/tmp/hub-socks`.
- Log directory is bind-mounted: `/var/log/hub:/var/log/hub`.

### 5) Install logrotate
```bash
sudo ./scripts/install-logrotate.sh
sudo logrotate -d /etc/logrotate.d/meridian
```
