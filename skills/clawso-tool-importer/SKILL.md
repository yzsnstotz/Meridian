---
name: clawso-tool-importer
description: >
  Guides an agent through importing an external repository as a Clawso tool.
  Use this skill whenever the user provides a repo URL and wants to import, wrap,
  publish, or onboard it as a Clawso tool. Also trigger for phrases like
  "add this tool", "import from GitHub", "wrap this repo", "list this on Clawso",
  "onboard this MCP tool", or any request involving an external source URL and
  Clawso tool creation. Accepts any fetchable git-hosted repo (GitHub, GitLab,
  Bitbucket, Smithery, self-hosted, etc.).
---

# Clawso Tool Importer — Orchestrator

This skill orchestrates the full pipeline for importing an external repository as a Clawso tool. It coordinates three sub-skills in strict sequence and enforces gates between phases.

## Category Taxonomy

Clawso classifies tools into three categories. Only Cat 1 and Cat 2 are supported in MVP.

| Category | Type | Description | Clawso runtime |
|----------|------|-------------|----------------|
| **Cat 1** | TUP (Tool Use Package) | One-shot bootstrapper/installer. Runs once on user's local machine, then exits. | Local execution with verify.clawso.ai check |
| **Cat 2** | MFP (MCP Function Protocol) | Stateless cloud function on Cloudflare Workers. All state in params, nothing stored. | `execute(params, context)` on Workers |
| **Cat 4** | Server tool (post-MVP) | Requires always-on server infrastructure or persistent state across calls. | Not supported in MVP |

## Prerequisites

Before calling any sub-skill, collect the following from the user. If any are missing after the user's first message, ask for them explicitly.

| Field | Description | Validation |
|-------|-------------|------------|
| `repo_url` | Full URL to any fetchable git repository | Must be accessible (not 404, not private) |
| `tool_slug` | Target slug for Clawso | Lowercase, hyphens only, unique. Agent proposes from repo name, user confirms. |
| `pricing_type` | `fixed` or `bonding_curve` | Ask user to choose |
| `initial_price_points` | Integer | For `fixed`: must be 1-1000. For `bonding_curve`: becomes `base_price`. |

## Shared State

Maintain this state object throughout all phases. Pass it explicitly when loading each sub-skill.

```
shared_state = {
  repo_url:           string,      // any fetchable git repo URL
  tool_slug:          string,      // lowercase, hyphens only
  confirmed_category: "cat1" | "cat2" | "cat4",
  pricing_type:       "fixed" | "bonding_curve",
  initial_price:      integer,
  license_confirmed:  boolean,     // set by classifier
  has_private_backend: boolean,    // set by classifier
  source_origin:      "external",  // always "external" for imported tools
  source_platform:    string       // auto-detected from URL domain, fallback "other"
}
```

### Source Platform Detection

Auto-detect `source_platform` from the `repo_url` domain:
- `github.com` -> `"github"`
- `gitlab.com` -> `"gitlab"`
- `bitbucket.org` -> `"bitbucket"`
- `smithery.ai` -> `"smithery"`
- Any other domain -> `"other"`

This list is illustrative, not exhaustive. Extract the domain and use it as the platform identifier where recognizable; fall back to `"other"` for unrecognized domains.

## Phase Execution (strict sequence, no skipping)

```
Step 1 -> Load sub-skills/01-classifier.md -> run classifier -> present output to user
         GATE: Do not proceed until user explicitly confirms or rejects the category.

Step 2 -> If user rejects -> ask for manual category input or abort.
         If user confirms Cat 4 -> output the Cat 4 block message (see below) -> STOP.
         If user confirms Cat 1 or Cat 2 -> proceed to Step 3.

Step 3 -> Load sub-skills/02-wrapper.md -> run wrapper with {repo_url, confirmed_category, tool_slug}

Step 4 -> Load sub-skills/03-doc-generator.md -> run doc-generator with all collected state

Step 5 -> Present final file list to user with next-steps checklist
```

## Abort Conditions

Immediately stop and explain to the user (without proceeding further) if any of the following are true after classifier runs:

- License is not MIT or Apache 2.0
- Repo is private or returns a 404
- Classifier cannot determine category with any confidence (output: ask user to classify manually)

## Cat 4 Stop Message

When confirmed category is Cat 4, output this exact block and halt:

```
Cat 4 tools (server-hosted, persistent infrastructure) are not supported in Clawso MVP.

This repo requires always-on server infrastructure or persistent state across calls,
which places it in Category 4. Clawso MVP only supports:
  - Cat 1 -- One-shot bootstrapper/installer (TUP)
  - Cat 2 -- Stateless cloud function on Cloudflare Workers (MFP)

Options:
  1. Redesign the tool as a stateless Cat 2 function (if the core logic can be made stateless)
  2. Revisit after Phase 3 when Cat 4 server tools are supported
  3. Manually override the category -- type "force cat1" or "force cat2" to proceed at your own risk
```

## Relationship to Manifest Skill

After the importer pipeline completes, the wrapped code and generated documents can be passed to the `manifest` skill (`skills/manifest/SKILL.md`) to:
- Fork the repo under the `clawso-manifest-gen` account
- Generate the final `manifest.json` for the deploy pipeline
- Push and return admin-form values

The importer prepares the analysis, wrapping, and documentation; the manifest skill handles the actual repo fork and deploy artifact creation.

## Reference Files

For understanding the current deploy contract, consult:
- `workers/mcp-clawso/src/handlers/deploy.ts` — external MCP deploy validation
- `src/bff/integrations.mjs` — integration endpoints
- `src/bff/router.mjs` — submission routing and field mapping
- `src/bff/archive.mjs` — first-party MCP archive validation
