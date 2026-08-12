# Gateway guide

Meridian Gateway exposes OpenAI- and Anthropic-shaped HTTP endpoints backed by
locally authenticated provider CLIs. It is optional and deliberately outside
the native Runtime/Orchestrator supervisor lifecycle.

## Start

Build the workspace first, then launch the Gateway:

```bash
npm run build
npm run start:gateway
```

Defaults:

- Base URL: `http://127.0.0.1:8789`
- API key file: `~/.meridian-gateway/gateway-key`
- Usage ledger: `~/.meridian-gateway/usage.jsonl`

Open the base URL to inspect provider login state and discover available
models. The API key directory and file are created with private permissions.

## Discover models

```bash
curl http://127.0.0.1:8789/v1/models
```

Choose a model ID returned by that endpoint. Model availability reflects the
matching locally installed and authenticated provider CLI.

## OpenAI-compatible request

```bash
export MERIDIAN_GATEWAY_KEY="$(tr -d '\n' < "$HOME/.meridian-gateway/gateway-key")"

curl http://127.0.0.1:8789/v1/chat/completions \
  -H "Authorization: Bearer $MERIDIAN_GATEWAY_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "<model-id>",
    "messages": [{"role": "user", "content": "Reply with one sentence."}]
  }'
```

OpenAI-compatible clients can use:

```text
base_url = http://127.0.0.1:8789/v1
api_key  = <contents of ~/.meridian-gateway/gateway-key>
```

Streaming requests are supported with `"stream": true`.

## Anthropic-compatible request

```bash
curl http://127.0.0.1:8789/v1/messages \
  -H "x-api-key: $MERIDIAN_GATEWAY_KEY" \
  -H 'anthropic-version: 2023-06-01' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "<model-id>",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Reply with one sentence."}]
  }'
```

The same generated key is accepted as an OpenAI Bearer token or Anthropic
`x-api-key`.

## Bind configuration

```dotenv
MERIDIAN_GATEWAY_HOST=127.0.0.1
MERIDIAN_GATEWAY_PORT=8789
```

Keep the Gateway on loopback. If remote access is required, place it behind TLS
and independent access control, restrict the network path, and protect the
generated key as a credential.

## Key rotation

The local Gateway UI can display and rotate its key. After rotation, update
every client immediately; the previous key stops authorizing completion
requests.

Never commit `gateway-key`, usage records, provider credential files, or shell
output containing the key.
