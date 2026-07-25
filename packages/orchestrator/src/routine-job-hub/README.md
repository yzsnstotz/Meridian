# Routine Job Hub

The Routine Job Hub owns `127.0.0.1:8765` and renders links to individual routine-job dashboards. It reads the registry on every request so operators can add or edit entries without rebuilding Meridian.

## Start

```bash
npx tsx src/routine-job-hub/server.ts
```

The server defaults to `127.0.0.1:8765`. Override the port or registry path when needed:

```bash
ROUTINE_JOB_HUB_PORT=8765 \
ROUTINE_JOB_HUB_REGISTRY=/Users/yzliu/work/Docs/Projects/routine-job/hub.json \
npx tsx src/routine-job-hub/server.ts
```

If Bun is available on the host, the same TypeScript entry point can be run with:

```bash
bun run src/routine-job-hub/server.ts
```

## Registry

The default registry path is `/Users/yzliu/work/Docs/Projects/routine-job/hub.json`. The file is a JSON array:

```json
[
  {
    "id": "github-opc-scan",
    "name": "GitHub OPC Scan",
    "description": "Repository automation scan",
    "url": "http://127.0.0.1:18765",
    "health_path": "/healthz"
  }
]
```

Each request reads the registry fresh. `GET /api/entries` returns the entries with live HEAD-probe status, and `GET /api/health` returns the hub status and parsed entry count.
