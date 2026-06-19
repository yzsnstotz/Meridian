# Meridian Phase 0

## Meridian Gateway Service

`meridian-gateway` is Meridian's OpenAI-compatible HTTP front door for logged-in
CLI subscriptions. It exposes `/v1/chat/completions`, `/v1/models`, and
Anthropic-compatible `/v1/messages` routes, then routes each request to the
matching local CLI provider: Codex, Claude, or Gemini. The service is designed
for tools that already know the OpenAI or Anthropic wire format but should use
the user's existing subscription login instead of direct provider API keys. The
root Gateway page is the operator surface: connect each CLI, inspect the safe
account details each provider exposes, run a direct text test against a chosen
CLI/model, copy the generated API key, and see the live model catalog that the
Gateway can actually advertise.

Start it locally:

```bash
MERIDIAN_GATEWAY_PORT=8789 npx tsx src/web/v1-gateway.ts
```

On first start it creates an API key at
`~/.meridian-gateway/gateway-key`. Use that key as `Authorization: Bearer
<key>` for OpenAI-compatible calls, or as `x-api-key: <key>` for
Anthropic-compatible calls. The root page and `/providers/*` login routes help
connect or install the backing CLIs. `/v1/models` is intentionally live rather
than a hardcoded table: Codex is sourced from `codex app-server`/local Codex
catalog fallbacks, and API-backed catalogs are used when configured. Providers
whose CLIs do not expose a model-list/status dimension report that limitation
instead of advertising stale model IDs.

Example:

```bash
KEY="$(cat ~/.meridian-gateway/gateway-key)"
curl http://127.0.0.1:8789/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{ "role": "user", "content": "Say gateway ok." }]
  }'
```

## Telegram Bot Registration (T-03)
1. Open `@BotFather` in Telegram and run `/newbot`.
1. Save the generated token and set `TELEGRAM_BOT_TOKEN` in `.env`.
1. Optional multi-bot: set `TELEGRAM_BOT_TOKENS` as a comma-separated list of additional bot tokens.
1. Set your Telegram user id in `ALLOWED_USER_IDS`.
1. `/spawn` defaults to the parent of the Meridian repo. In this checkout that is `/Users/yzliu/work`. Optional: set `AGENT_WORKDIR` in `.env` to override the default repo directory.
1. Configure slash commands in `@BotFather` with `/setcommands`:

```text
spawn - Spawn a new agent instance
restart - Restart Meridian, meridian-roles, or ADS
browse - Browse repo and return exact file/folder path
kill - Kill an existing instance
status - Get current instance status
attach - Attach this chat to a thread
detach - Detach this chat from the active thread
reboot - Restart an existing thread in place
gui - Get the Web GUI link for a thread
approve - Send approval input to a pane_bridge thread
update - Toggle monitor progress updates for a thread
mupdate - Send one manual progress update for a thread
list - List active instances
help - Show command usage
```

`/spawn` supports an optional directory argument:

```text
/spawn type=codex mode=pane_bridge dir=/absolute/path/to/repo
/spawn type=codex mode=stateless_call dir=/absolute/path/to/repo
```

`/detach`, `/reboot`, and `/gui` support thread-oriented control flows:

```text
/detach
/detach thread=codex_01
/reboot thread=codex_01
/gui
/gui thread=codex_01
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

`/approve` sends approval keystrokes into a `pane_bridge` tmux session:

```text
/approve run thread=cursor_01
/approve allow thread=cursor_01
/approve all thread=cursor_01
/approve skip thread=cursor_01
```

`/model` opens a Telegram picker that fetches the live model list for the thread's current provider:

```text
/model
/model thread=codex_01
```

For `codex` threads, Meridian queries `codex app-server` first (uses Codex login/session auth), and only falls back to `OPENAI_API_KEY` if app-server model listing is unavailable.

## Email Loop Runtime Integration

External services such as Email Loop should use the Meridian Web API instead of
scraping Hub pages.

Discovery:

```bash
curl -H "Authorization: Bearer $WEB_GUI_TOKEN" \
  -H "X-Meridian-Caller-Id: email-loop" \
  -H "X-Meridian-Caller-Key: $MERIDIAN_EMAIL_LOOP_CALLER_KEY" \
  "$MERIDIAN_HTTP/api/runtime/catalog"
```

CLI equivalent:

```bash
meridian runtime catalog
```

Example response:

```json
{
  "ok": true,
  "providers": [
    {
      "provider": "codex",
      "label": "Codex",
      "status": "available",
      "capabilities": { "oauth": true, "api_key": true, "model_list": true },
      "default_credential_id": "host-default-codex",
      "credentials": [
        {
          "provider": "codex",
          "credential_id": "host-default-codex",
          "label": "Default (codex)",
          "kind": "oauth",
          "status": "active",
          "is_default": false,
          "is_host_default": true
        }
      ],
      "models": [{ "id": "gpt-5.4", "label": "GPT-5.4" }],
      "error": null
    },
    {
      "provider": "claude",
      "label": "Claude",
      "status": "unavailable",
      "capabilities": { "oauth": false, "api_key": false, "model_list": true },
      "default_credential_id": "host-default-claude",
      "credentials": [
        {
          "provider": "claude",
          "credential_id": "host-default-claude",
          "label": "Default (claude)",
          "kind": "oauth",
          "status": "active",
          "is_default": false,
          "is_host_default": true
        }
      ],
      "models": [],
      "error": {
        "code": "model_list_unavailable",
        "message": "No API key configured for provider=claude"
      }
    }
  ],
  "credentials": [
    {
      "provider": "codex",
      "credential_id": "host-default-codex",
      "label": "Default (codex)",
      "kind": "oauth",
      "status": "active",
      "is_default": false,
      "is_host_default": true
    },
    {
      "provider": "claude",
      "credential_id": "host-default-claude",
      "label": "Default (claude)",
      "kind": "oauth",
      "status": "active",
      "is_default": false,
      "is_host_default": true
    }
  ],
  "defaults": {
    "codex": "host-default-codex",
    "claude": "host-default-claude"
  }
}
```

Credential/account operations:

```bash
meridian credentials list
meridian credentials oauth-start --label "Email Loop Codex" --mode device
meridian credentials oauth-poll <job-id>
meridian credentials oauth-cancel <job-id>
meridian credentials api-key --label "Email Loop API" --base-url https://api.openai.com/v1 --model gpt-5.4 --env-var OPENAI_API_KEY --key "$OPENAI_API_KEY"
meridian credentials set-default <credential-id>
meridian credentials revoke <credential-id> --yes
```

To start work with a selected runtime, use the returned `provider`, model `id`,
and optional `credential_id` with the existing spawn API or CLI.

## Telegram Webhook Mode

Leave `WEBHOOK_URL` empty to keep long polling. To enable webhook mode, set a public HTTPS URL that ends at the base webhook path, for example:

```text
WEBHOOK_URL=https://bot.example.com/webhook
WEBHOOK_PORT=8080
WEBHOOK_SECRET_TOKEN=replace-with-random-secret
```

Behavior:
- Single bot: Meridian serves Telegram updates on `/webhook`.
- Multiple bots via `TELEGRAM_BOT_TOKENS`: Meridian serves `/webhook/<bot_id>` per bot and registers each public URL automatically.
- `WEBHOOK_SECRET_TOKEN` is forwarded to Telegram and verified by grammY on incoming requests.

Deployment note: `WEBHOOK_PORT` is the local listener port. In production, terminate TLS and route the public webhook URL to this port through your reverse proxy or load balancer.

Optional external service registration:

```text
COORDINATOR_SOCKET_PATH=/tmp/coordinator.sock
COORDINATOR_INTENTS=delegate,plan,review
```

When both variables are set, the hub statically registers that socket and forwards the listed non-built-in intents there.

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
