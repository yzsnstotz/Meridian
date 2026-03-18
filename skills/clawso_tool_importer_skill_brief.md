# Coding Agent Brief: `clawso-tool-importer` Skill

**Version**: 1.0  
**Date**: March 2026  
**Purpose**: Instruct a coding agent to build the `clawso-tool-importer` skill from scratch.  
**Output location**: `/mnt/skills/user/clawso-tool-importer/`

---

## 0. What You Are Building

A Claude skill (set of SKILL.md instruction files) that guides an agent through importing an external GitHub/Smithery repository as a Clawso tool. The skill has **one orchestrating entry point** and **three sub-skills**, each handling one phase of the pipeline.

```
/mnt/skills/user/clawso-tool-importer/
├── SKILL.md                         ← Orchestrator (entry point)
└── sub-skills/
    ├── 01-classifier.md             ← Phase 1: Analyse repo → recommend Cat 1 / 2 / 4
    ├── 02-wrapper.md                ← Phase 2: Wrap code to Clawso standard
    └── 03-doc-generator.md          ← Phase 3: Generate manifest + submission documents
```

Do **not** create any files outside this directory. Do **not** modify any existing skills.

---

## 1. Reference Documents

The following PRDs are your source of truth for all field names, schemas, and business rules. Read them before generating any skill content. They are available in the project files.

| Document | What to extract from it |
|---|---|
| `CLAWSO_PRD_MVP_v1_0.docx` | Tool types (TUP/MFP), source_origin values, pricing mechanism, tool_submission fields, user flow |
| `CLAWSO_MCP_Server_PRD_MVP_v1_0.docx` | MFP execute() function contract, ToolContext, ToolResult, allowed_hosts rules, user_llm constraints |
| `CLAWSO_Admin_PRD_MVP_v1_0.docx` | External tool import form fields, submission_type values, Semgrep scan flow, audit checklist items |
| `verify_CLAWSO_PRD_MVP_v1_0.docx` | /v1/check call contract, tool_slug format, tool_type enum values |
| `clawso_strategic_direction.docx` | Cat 1 / Cat 2 / Cat 4 taxonomy definitions (Section 1.1 table) |

---

## 2. Skill File Format Requirements

Every `.md` file you create **must** begin with a YAML frontmatter block:

```yaml
---
name: <skill-identifier>
description: >
  <2–4 sentences. What this skill does AND when to trigger it.
   Be explicit about trigger phrases. Err on the side of "pushy" —
   list the contexts where this should activate.>
---
```

After frontmatter: plain Markdown. No JSX, no HTML. Use fenced code blocks for JSON/TypeScript examples.

---

## 3. SKILL.md — Orchestrator

### 3.1 Frontmatter

```yaml
---
name: clawso-tool-importer
description: >
  Guides an agent through importing an external GitHub or Smithery repository
  as a Clawso tool. Use this skill whenever the user provides a repo URL and
  wants to import, wrap, publish, or onboard it as a Clawso tool. Also trigger
  for phrases like "add this tool", "import from GitHub", "wrap this repo",
  "list this on Clawso", or "onboard this MCP tool".
---
```

### 3.2 Body — what to write

Write the orchestrator body to cover exactly these sections, in order:

#### Section A — Prerequisites (agent reads before starting)
List what the agent must collect before proceeding:
- `repo_url` — full GitHub or Smithery URL provided by user
- `tool_slug` — target slug (agent proposes from repo name, user confirms; must be lowercase, hyphens only, unique)
- `pricing_type` — `fixed` or `bonding_curve` (agent asks user to choose)
- `initial_price_points` — integer (agent asks; must be between 1–1000 for fixed)

If any of these are missing after the user's first message, the orchestrator must ask for them **before** calling any sub-skill.

#### Section B — Phase execution order (hard-coded, no skipping)

Write this as a numbered gate sequence. The agent must follow it strictly:

```
Step 1 → Load sub-skills/01-classifier.md → run classifier → present output to user
         GATE: Do not proceed until user explicitly confirms or rejects the category.

Step 2 → If user rejects → ask for manual category input or abort.
         If user confirms Cat 4 → output the Cat 4 block message (see §3.3) → STOP. Do not continue.
         If user confirms Cat 1 or Cat 2 → proceed to Step 3.

Step 3 → Load sub-skills/02-wrapper.md → run wrapper with {repo_url, confirmed_category, tool_slug}

Step 4 → Load sub-skills/03-doc-generator.md → run doc-generator with all collected state

Step 5 → Present final file list to user with next-steps checklist
```

#### Section C — Shared state block

Instruct the agent to maintain this state object throughout all phases and pass it explicitly when loading each sub-skill:

```
shared_state = {
  repo_url:           string,
  tool_slug:          string,
  confirmed_category: "cat1" | "cat2" | "cat4",
  pricing_type:       "fixed" | "bonding_curve",
  initial_price:      integer,
  license_confirmed:  boolean,   // set by classifier
  has_private_backend: boolean,  // set by classifier
  source_origin:      "external" // always "external" for imported tools
}
```

#### Section D — Abort conditions

The orchestrator must immediately stop and explain to the user (without proceeding further) if any of the following are true after classifier runs:
- License is not MIT or Apache 2.0
- Repo is private or returns a 404
- Classifier cannot determine category with any confidence (output: ask user to classify manually)

### 3.3 Cat 4 Stop Message

When confirmed category is Cat 4, output this exact block and halt:

```
⛔ Cat 4 tools (server-hosted, persistent infrastructure) are not supported in Clawso MVP.

This repo requires always-on server infrastructure or persistent state across calls,
which places it in Category 4. Clawso MVP only supports:
  • Cat 1 — One-shot bootstrapper/installer (TUP)
  • Cat 2 — Stateless cloud function on Cloudflare Workers (MFP)

Options:
  1. Redesign the tool as a stateless Cat 2 function (if the core logic can be made stateless)
  2. Revisit after Phase 3 when Cat 4 server tools are supported
  3. Manually override the category — type "force cat1" or "force cat2" to proceed at your own risk
```

---

## 4. `sub-skills/01-classifier.md` — Repo Classifier

### 4.1 Frontmatter

```yaml
---
name: clawso-tool-importer-classifier
description: >
  Sub-skill of clawso-tool-importer. Analyses a GitHub or Smithery repository
  and classifies it as Clawso Cat 1 (bootstrapper/TUP), Cat 2 (stateless MFP
  cloud function), or Cat 4 (server tool, post-MVP). Called by the orchestrator;
  do not trigger independently.
---
```

### 4.2 Decision Tree (write this verbatim as a section in the skill)

The agent must evaluate signals in this exact priority order. First match wins.

```
CLASSIFIER DECISION TREE
─────────────────────────────────────────────────────────────────
Signal check order        → Category assigned if TRUE
─────────────────────────────────────────────────────────────────
1. Has persistent DB / file-system state across calls?
   OR requires always-on background process / daemon?
   OR uses WebSockets / long-lived connections?           → Cat 4

2. Exports a single execute(params, context) function
   OR is designed as an MCP server function
   OR is stateless (all state in params, nothing stored)?  → Cat 2

3. Is a setup/installer/bootstrapper script
   OR installs local dependencies / configures environment
   OR is a PyInstaller .exe / .dmg workflow
   OR runs once on a local machine and exits?              → Cat 1

4. None of the above match clearly                        → UNCERTAIN
   (output: confidence = low, recommend manual review)
─────────────────────────────────────────────────────────────────
```

### 4.3 What the classifier must inspect

Instruct the agent to examine these repo artifacts (in order of availability):

1. `README.md` — look for: "server", "daemon", "stateless", "MCP", "installer", "setup", "one-time"
2. `package.json` / `pyproject.toml` / `requirements.txt` — look for: `express`, `fastapi`, `flask`, `ws`, `socket.io`, `sqlite`, `prisma` (→ Cat 4 signals); `@modelcontextprotocol/sdk` (→ Cat 2 signal)
3. Entry point file (index.ts / main.py / app.py) — look for: persistent state, DB connections, background loops
4. `mcp.json` or any manifest file — if present, strong Cat 2 signal

### 4.4 License check (mandatory step within classifier)

Before outputting category, the classifier must:
1. Look for `LICENSE` or `LICENSE.md` file in repo root
2. Check for `"MIT"` or `"Apache-2.0"` (case-insensitive)
3. If not found or different license: set `license_confirmed = false`, flag as **BLOCKER** in output
4. If found: set `license_confirmed = true`

### 4.5 Private backend check (mandatory step within classifier)

Scan entry point and any `config` files for:
- Hardcoded non-public domain URLs (e.g. `api.internal.*`, `*.private.*`, custom non-npm domains in fetch/axios calls)
- Environment variables that look like private API keys specific to the original developer (e.g. `ORIGINAL_AUTHOR_API_KEY`, `PRIVATE_BACKEND_URL`)

Set `has_private_backend = true` if found. Flag each instance in output with the filename and line reference.

### 4.6 Classifier output format

The classifier must end with a structured output block in this exact format:

```
## Classifier Result

**Recommended Category**: Cat 2 — Stateless MFP Cloud Function
**Confidence**: high | medium | low
**License**: MIT ✅  |  Apache-2.0 ✅  |  [other] ⛔ BLOCKER
**Private backend calls detected**: Yes ⚠️ (see below) | No ✅

**Signals found**:
- [signal 1 — file:line if applicable]
- [signal 2]

**Blockers** (must resolve before import):
- [blocker description, or "None"]

**Warnings** (resolvable during wrapping):
- [warning description, or "None"]

---
Waiting for your confirmation. Reply "confirm cat2", "confirm cat1", or "override cat4" to proceed.
```

---

## 5. `sub-skills/02-wrapper.md` — Code Wrapper

### 5.1 Frontmatter

```yaml
---
name: clawso-tool-importer-wrapper
description: >
  Sub-skill of clawso-tool-importer. Adapts an external repository's code to
  Clawso's standard tool format based on confirmed category (Cat 1 TUP or
  Cat 2 MFP). Called by the orchestrator after user confirms category; do not
  trigger independently.
---
```

### 5.2 Cat 2 (MFP) Wrapping Rules

Write these as explicit rules the agent must follow when wrapping a Cat 2 tool:

**Rule W2-1 — Function signature**  
The tool's entry point must be adapted to this exact signature:
```typescript
export async function execute(
  params: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult>
```

Where `ToolContext` and `ToolResult` are defined as:
```typescript
interface ToolContext {
  userId: string;
  toolSlug: string;
  callId: string;
  balanceAfter: number;
  runtimeMode: "user_llm"; // always this value in MVP
}

interface ToolResult {
  success: boolean;
  data?: unknown;
  errorCode?: string;
  errorMessage?: string; // user-visible
}
```

**Rule W2-2 — LLM API calls forbidden**  
Scan for any calls to: `openai`, `anthropic`, `claude`, `gpt`, `llm`, `ChatCompletion`, `messages.create`.  
If found: add a `// CLAWSO: REMOVE — LLM calls not permitted in user_llm mode` annotation on each line. Do not delete — annotate for human review.

**Rule W2-3 — allowed_hosts extraction**  
Scan all `fetch()`, `axios.get/post`, `http.request` calls. Extract every unique domain called.  
Output as a list: these become the `allowed_hosts` array in the manifest.  
Flag any domain that is not a well-known public API (e.g. not `api.github.com`, `api.openai.com`, etc.) with `// CLAWSO: REVIEW — confirm this domain is intentional`.

**Rule W2-4 — No platformApiKey**  
If any reference to `context.platformApiKey` exists, annotate: `// CLAWSO: REMOVE — platformApiKey does not exist in MVP`.

**Rule W2-5 — No cross-call state**  
If any module-level mutable variables are used to persist state between calls (e.g. `let cache = {}` at module scope that is written to during execution), annotate: `// CLAWSO: REVIEW — stateful variable, violates stateless execution model`.

**Rule W2-6 — Timeout declaration**  
If the tool's README or code suggests it may run longer than 30 seconds, add a comment at the top of the execute function:
```typescript
// CLAWSO: Declare timeout in manifest if execution may exceed 30s (max 60s)
```

### 5.3 Cat 1 (TUP) Wrapping Rules

**Rule W1-1 — Verification hook**  
Add a comment block at the top of the main entry script:
```python
# CLAWSO TUP INTEGRATION REQUIRED:
# Before executing any logic, call verify.clawso.ai/v1/check with:
#   user_token, tool_slug, tool_type="tup", os_type, sdk_version, device_fingerprint
# Proceed only if response.valid == true
# See: verify.clawso.ai PRD §2.2 for full request schema
```

**Rule W1-2 — Offline guard**  
Add a comment where the main execution begins:
```python
# CLAWSO: This tool requires network connectivity. If verify call fails,
# display: "此工具需要网络连接才能运行。请检查您的网络后重试。"
# Do not allow offline execution.
```

**Rule W1-3 — Cython protection note**  
Add at end of file:
```python
# CLAWSO: Key verification logic must be compiled with Cython before packaging.
# See TUP packaging guide for Cython compilation and PyInstaller bundling steps.
```

### 5.4 Wrapper output

The wrapper must produce:
1. The adapted code file(s) with all annotations in place
2. A **Wrapper Summary** block at the end:

```
## Wrapper Summary

**Tool slug**: {tool_slug}
**Category**: Cat 2 MFP | Cat 1 TUP
**Lines annotated for removal**: N
**Lines annotated for review**: N
**Extracted allowed_hosts**: [list]
**LLM API calls found**: Yes ⚠️ / No ✅
**Stateful variables found**: Yes ⚠️ / No ✅

Human actions required before submission:
- [ ] Remove or replace all `// CLAWSO: REMOVE` lines
- [ ] Review all `// CLAWSO: REVIEW` lines and confirm intent
- [ ] Confirm allowed_hosts list is complete and correct
```

---

## 6. `sub-skills/03-doc-generator.md` — Document Generator

### 6.1 Frontmatter

```yaml
---
name: clawso-tool-importer-doc-generator
description: >
  Sub-skill of clawso-tool-importer. Generates all submission documents required
  to import an external tool into Clawso: MFP manifest, tool_submission record,
  pricing config, and admin review checklist. Called by the orchestrator after
  wrapping is complete; do not trigger independently.
---
```

### 6.2 Documents to generate

The doc-generator must produce all of the following. Write each as a labelled section in the skill with the exact field schema.

---

#### Document 1 — `mfp_manifest.json` (Cat 2 only)

```json
{
  "slug": "{tool_slug}",
  "display_name": "{tool display name in Chinese}",
  "source_origin": "external",
  "runtime_mode": "user_llm",
  "execution_timeout_seconds": 30,
  "allowed_hosts": [],
  "pricing": {
    "type": "fixed | bonding_curve",
    "fixed": {
      "points_per_call": 0
    },
    "bonding_curve": {
      "base_price": 0,
      "growth_factor": 0,
      "period_duration_days": 7,
      "period_calls_target": 0
    }
  },
  "params_schema": {},
  "result_schema": {},
  "license": "MIT | Apache-2.0",
  "original_repo_url": "{repo_url}",
  "copyright_notice": "Original copyright preserved. See LICENSE file."
}
```

Field rules:
- `slug`: lowercase, hyphens only, matches `tool_slug` from shared_state
- `source_origin`: always `"external"` for imported tools
- `runtime_mode`: always `"user_llm"` in MVP — hardcode this, never leave blank
- `execution_timeout_seconds`: default 30; set to 60 only if wrapper flagged a timeout warning
- `allowed_hosts`: populate from wrapper's extracted domain list
- `pricing.type`: from shared_state `pricing_type`
- For `fixed`: `points_per_call` from `initial_price` in shared_state
- For `bonding_curve`: populate `base_price` from `initial_price`; leave `growth_factor` and `period_calls_target` as 0 with a `// TODO` comment — these require developer input
- `params_schema` / `result_schema`: extract from the execute() function's TypeScript types or Python type hints if available; otherwise leave as `{}` with a `// TODO` comment
- `copyright_notice`: always include; this is a compliance requirement per Admin PRD §4

---

#### Document 2 — `tool_submission_record.json`

This maps to the Admin tool import form (Admin PRD §5):

```json
{
  "submission_type": "external_mcp",
  "source_platform": "github | smithery | cline | other",
  "source_url": "{repo_url}",
  "target_slug": "{tool_slug}",
  "display_name_zh": "{tool display name in Chinese}",
  "pricing_type": "fixed | bonding_curve",
  "initial_price_points": 0,
  "bonding_curve_params": {
    "base_price": 0,
    "growth_factor": 0,
    "period_duration_days": 7,
    "period_calls_target": 0
  },
  "status": "pending_manual_review",
  "semgrep_scan_status": "pending",
  "source_origin": "external",
  "author_id": null,
  "license_confirmed": true,
  "private_backend_removed": false
}
```

Field rules:
- `submission_type`: always `"external_mcp"` for repo imports
- `source_platform`: infer from URL (`github.com` → `"github"`, `smithery.ai` → `"smithery"`)
- `author_id`: always `null` for external tools — external tools do not participate in developer revenue share (Main PRD §2.5)
- `status`: always `"pending_manual_review"` on creation
- `semgrep_scan_status`: always `"pending"` — scan is triggered server-side after submission
- `private_backend_removed`: set to `false` if wrapper found private backend calls; `true` if none found. This is a human-confirmation field.
- `license_confirmed`: carry from classifier's `license_confirmed` value in shared_state

---

#### Document 3 — `admin_review_checklist.md`

Generate a filled-in checklist matching the Admin PRD §4 external MCP review items:

```markdown
# Admin Review Checklist — External MCP Import
**Tool slug**: {tool_slug}
**Source**: {repo_url}
**Generated**: {date}

## Pre-submission (completed by import agent)
- [x] Source repo is publicly accessible
- [x] License confirmed: MIT / Apache-2.0
- [ ] Original copyright notice preserved in adapted code
- [ ] Private backend calls removed or annotated for removal

## Semgrep scan (completed by platform on submission)
- [ ] Semgrep scan completed (auto-triggered on submission)
- [ ] No unresolved HIGH severity findings
- [ ] All WARN findings reviewed and disposition recorded

## Human review required (completed by Admin reviewer)
- [ ] Source code read; no obvious malicious logic
- [ ] allowed_hosts list reviewed; no suspicious domains
- [ ] Tool function does not call any LLM API (user_llm mode constraint)
- [ ] Tool description accurately describes functionality
- [ ] Copyright notice present in adapted code
- [ ] params_schema and result_schema are complete (no empty `{}`)
- [ ] Pricing config reviewed and approved

## Sign-off
Reviewer: _______________  Date: _______________
```

Pre-fill the checkboxes based on classifier and wrapper outputs:
- Check `[x]` for `License confirmed` only if `license_confirmed = true` in shared_state
- Check `[x]` for `Private backend calls removed` only if `has_private_backend = false` in shared_state

---

#### Document 4 — `pricing_config_block.json`

A standalone pricing configuration block for the Admin price override UI (Admin PRD §3, §8):

```json
{
  "tool_slug": "{tool_slug}",
  "admin_price_override": null,
  "pricing_constraints_applied": {
    "fixed_price_min_points": 1,
    "fixed_price_max_points": 1000,
    "bonding_curve_base_min": 1,
    "bonding_curve_growth_max": 10,
    "bonding_curve_period_options": [7, 14, 30]
  },
  "note": "Override admin_price_override to force a specific price regardless of developer setting. Leave null to use tool manifest pricing."
}
```

---

### 6.3 Doc-generator output

After generating all four documents, output a **Final Handoff Summary**:

```
## Import Package Complete

Files generated for tool: {tool_slug}

  📄 mfp_manifest.json            — Deploy to mcp.clawso.ai worker config
  📄 tool_submission_record.json  — Submit via Admin → External Tool Import
  📄 admin_review_checklist.md    — Attach to Admin review queue ticket
  📄 pricing_config_block.json    — Reference for Admin price configuration

## TODOs before submission
- [ ] Complete all `// TODO` fields in mfp_manifest.json (params_schema, result_schema)
- [ ] Remove or resolve all `// CLAWSO: REMOVE` annotations in wrapped code
- [ ] Confirm allowed_hosts list is final
- [ ] Run Semgrep locally before submitting (optional but recommended)
- [ ] Translate tool display name to Chinese if not already done

## Next step
Submit tool_submission_record.json via: Admin → Tools → 外部工具引入 (/admin/tools/import)
After submission, Semgrep scan triggers automatically. Tool enters pending_manual_review queue.
```

---

## 7. Validation Checklist for the Coding Agent

Before marking this task complete, verify every item:

- [ ] `/mnt/skills/user/clawso-tool-importer/SKILL.md` exists and has valid YAML frontmatter
- [ ] `/mnt/skills/user/clawso-tool-importer/sub-skills/01-classifier.md` exists with decision tree section
- [ ] `/mnt/skills/user/clawso-tool-importer/sub-skills/02-wrapper.md` exists with all W2-x and W1-x rules
- [ ] `/mnt/skills/user/clawso-tool-importer/sub-skills/03-doc-generator.md` exists with all 4 document schemas
- [ ] Orchestrator SKILL.md references all three sub-skills by relative path
- [ ] All four documents in doc-generator use field names that exactly match the PRD source documents
- [ ] Cat 4 stop message is present verbatim in orchestrator
- [ ] No file references an absolute path outside `/mnt/skills/user/clawso-tool-importer/`
- [ ] Every `.md` file begins with a `---` YAML frontmatter block
- [ ] `source_origin: "external"` and `author_id: null` appear in tool_submission_record schema
- [ ] `runtime_mode: "user_llm"` is hardcoded (not a variable) in mfp_manifest schema
- [ ] Wrapper summary block and doc-generator handoff summary are present in their respective skills

---

## 8. What the Coding Agent Must NOT Do

- Do not create a Python or TypeScript implementation — these are **instruction files** (`.md` only)
- Do not modify any files outside `/mnt/skills/user/clawso-tool-importer/`
- Do not invent field names — use only field names that appear in the PRD documents listed in §1
- Do not merge the three sub-skills into one file
- Do not omit the YAML frontmatter from any file
- Do not hardcode specific repo URLs or tool names in the skill content — all values must be parameterised with `{placeholder}` notation
- Do not skip the license check or the private backend check in the classifier
- Do not allow the wrapper to delete code — annotate only, never delete

---

*End of brief. Total output: 5 files. No other deliverables.*
