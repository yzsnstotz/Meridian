---
name: clawso-tool-importer-classifier
description: >
  Sub-skill of clawso-tool-importer. Analyses a repository (any fetchable git
  source) and classifies it as Clawso Cat 1 (bootstrapper/TUP), Cat 2 (stateless
  MFP cloud function), or Cat 4 (server tool, post-MVP). Called by the
  orchestrator; do not trigger independently.
---

# Repo Classifier

Analyse the target repository and classify it into a Clawso tool category. This sub-skill is called by the orchestrator after prerequisites are collected.

## Input

Receives from orchestrator shared_state:
- `repo_url` — the repository to analyse
- `tool_slug` — proposed slug (for reference only at this stage)

## Decision Tree

Evaluate signals in this exact priority order. First match wins.

```
CLASSIFIER DECISION TREE
---------------------------------------------------------------
Signal check order                                    -> Category
---------------------------------------------------------------
1. Has persistent DB / file-system state across calls?
   OR requires always-on background process / daemon?
   OR uses WebSockets / long-lived connections?        -> Cat 4

2. Exports a single execute(params, context) function
   OR is designed as an MCP server function
   OR is stateless (all state in params, nothing stored)? -> Cat 2

3. Is a setup/installer/bootstrapper script
   OR installs local dependencies / configures environment
   OR is a PyInstaller .exe / .dmg workflow
   OR runs once on a local machine and exits?          -> Cat 1

4. None of the above match clearly                    -> UNCERTAIN
   (output: confidence = low, recommend manual review)
---------------------------------------------------------------
```

## What to Inspect

Examine these repo artifacts in order of availability:

1. **`README.md`** — look for keywords: "server", "daemon", "stateless", "MCP", "installer", "setup", "one-time", "cloud function", "worker"
2. **`package.json` / `pyproject.toml` / `requirements.txt`** — look for:
   - Cat 4 signals: `express`, `fastapi`, `flask`, `ws`, `socket.io`, `sqlite`, `prisma`, `sequelize`, `typeorm`, `mongoose`, `redis` (as persistent store)
   - Cat 2 signals: `@modelcontextprotocol/sdk`, `wrangler`, `miniflare`
   - Cat 1 signals: `pyinstaller`, `cx_freeze`, `electron-builder`, `pkg`
3. **Entry point file** (`index.ts` / `main.py` / `app.py` / `src/index.js`) — look for: persistent state, DB connections, background loops, `listen()` calls, WebSocket handlers
4. **`mcp.json` or any manifest file** — if present, strong Cat 2 signal

## License Check (mandatory)

Before outputting category, you MUST:

1. Look for `LICENSE` or `LICENSE.md` or `COPYING` file in repo root
2. Check for `"MIT"` or `"Apache-2.0"` (case-insensitive)
3. Also check `package.json` `license` field or `pyproject.toml` `[project].license`
4. If not found or different license: set `license_confirmed = false`, flag as **BLOCKER** in output
5. If found: set `license_confirmed = true`

## Private Backend Check (mandatory)

Scan entry point and any config files for:

- Hardcoded non-public domain URLs (e.g. `api.internal.*`, `*.private.*`, custom non-npm domains in fetch/axios calls)
- Environment variables that look like private API keys specific to the original developer (e.g. `ORIGINAL_AUTHOR_API_KEY`, `PRIVATE_BACKEND_URL`)
- Any `.env.example` or config template with private-looking endpoints

Set `has_private_backend = true` if found. Flag each instance in output with the filename and line reference.

## Output Format

The classifier MUST end with a structured output block in this exact format:

```
## Classifier Result

**Recommended Category**: Cat 2 -- Stateless MFP Cloud Function
**Confidence**: high | medium | low
**License**: MIT [confirmed] | Apache-2.0 [confirmed] | [other] BLOCKER
**Private backend calls detected**: Yes [warning] (see below) | No [confirmed]

**Signals found**:
- [signal 1 -- file:line if applicable]
- [signal 2]

**Blockers** (must resolve before import):
- [blocker description, or "None"]

**Warnings** (resolvable during wrapping):
- [warning description, or "None"]

---
Waiting for your confirmation. Reply "confirm cat2", "confirm cat1", or "override cat4" to proceed.
```

## Output to Shared State

After user confirms, update shared_state with:
- `confirmed_category`: the confirmed category
- `license_confirmed`: boolean from license check
- `has_private_backend`: boolean from private backend check
