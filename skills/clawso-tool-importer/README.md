# clawso-tool-importer — Troubleshooting & Reference

This README covers information **not included in the skill files** — design decisions, known gaps, codebase coupling points, and debugging guidance. Read this when investigating failures or planning changes to the import pipeline.

## Design Decisions & Conflict Resolutions

These decisions were made during skill creation (2026-03-19) after a conflict analysis against the live codebase. If the system has changed since then, re-verify these assumptions.

### D1 — Manifest filename: `manifest.json` not `mfp_manifest.json`

Two validation paths exist in the codebase:

| Path | File | Expected filename | Timeout range |
|------|------|-------------------|---------------|
| First-party MCP upload | `src/bff/archive.mjs` (line ~92) | `mfp_manifest.json` | 5-30s |
| External MCP deploy | `workers/mcp-clawso/src/handlers/deploy.ts` (line ~169) | `manifest.json` | 5-60s |

This skill targets the **external deploy path**, so it uses `manifest.json`. If a tool imported via this skill is later processed through the first-party archive path, it will fail validation. This is intentional — external imports should only go through the external deploy pipeline.

### D2 — `allowed_hosts` is not enforced at runtime

The Worker template (`deploy.ts`) does **not** wrap `fetch()` calls to enforce domain whitelisting. The `allowed_hosts` field is extracted by the wrapper skill and included in `manifest.json` purely for **admin review visibility**. Runtime enforcement is a separate work item tracked outside this skill.

**Impact on troubleshooting:** If a deployed tool makes unexpected network calls, `allowed_hosts` in the manifest will not prevent them. The security boundary is currently the Semgrep scan + human review, not runtime enforcement.

### D3 — `private_backend_removed` is stored in `scan_results` JSONB

The `tool_submissions` table has no `private_backend_removed` column. This field appears in the `tool_submission_record.json` output but at submission time should be stored inside the `scan_results` JSONB column, not as a top-level field.

**If submission fails with an unknown column error:** Check that the BFF router (`src/bff/router.mjs`, around line ~2028) is writing this field into `scan_results` rather than directly into the table.

### D4 — `runtime_mode` DB constraint is wider than MVP allows

Migration 027 changed the `runtime_mode` constraint to allow `platform_llm` and `developer_backend` in addition to `user_llm`. The skill hardcodes `user_llm` because the MCP Server PRD restricts MVP to this mode only. If a future phase enables other modes, the skill's doc-generator must be updated.

### D5 — `entry_point` validation differs by path

First-party uploads (`archive.mjs`) require `entry_point` to be exactly `dist/index.js`. The external deploy path (`deploy.ts`) accepts any entry point from the manifest. This skill does not constrain `entry_point` — the wrapper creates an adapter file and the manifest points to it. If you see entry point validation errors, check which deploy path was used.

### D6 — Source platform is not a fixed enum

The `source_platform` field is auto-detected from the repo URL domain and can be any string value. The brief originally listed `github | smithery | cline | other` but this was expanded to be inclusive of any fetchable git source. The fallback is `"other"`. If the BFF router or admin form validates against a fixed set, that validation needs updating to accept arbitrary values or map unknown domains to `"other"`.

## Known Gaps

These are system-level gaps that affect the import pipeline but are outside this skill's scope.

| Gap | Where it matters | Status |
|-----|------------------|--------|
| `allowed_hosts` runtime enforcement | Deployed tools can call any domain | Not built; tracked separately |
| `params_schema` / `result_schema` auto-extraction | Doc-generator leaves `{}` if types not inferrable | Manual completion required before submission |
| Cat 4 server tool support | Classifier blocks Cat 4 with a stop message | Deferred to Phase 3 |
| Bonding curve `growth_factor` / `period_calls_target` | Left as 0 in generated docs | Requires developer/PM input per-tool |
| Semgrep scan is server-side only | Skill recommends local scan but doesn't enforce | Optional pre-submission step |

## Codebase Coupling Points

These are the files this skill's output directly interfaces with. If any of these change, the skill may need updating.

### Database schema (relevant migrations)

| Migration | What it defines | Skill dependency |
|-----------|----------------|------------------|
| 023 | `source_origin IN ('platform', 'third_party', 'external')` | `source_origin: "external"` in submission record |
| 023 | `submission_type IN ('tup', 'mfp', 'external_mcp')` | `submission_type: "external_mcp"` in submission record |
| 027 | `runtime_mode` constraint, `timeout_seconds` range | `runtime_mode: "user_llm"`, timeout 5-60s |

### BFF routing

| File | Lines (approx) | What it does | Coupling |
|------|----------------|--------------|----------|
| `src/bff/router.mjs` | ~1980-2050 | Maps submission JSON to DB insert | Field names in `tool_submission_record.json` must match |
| `src/bff/router.mjs` | ~2028 | Writes `scan_results` JSONB | Where `private_backend_removed` is stored |
| `src/bff/integrations.mjs` | — | Integration endpoint handling | Submission flow entry point |

### Deploy pipeline

| File | What it validates | Coupling |
|------|-------------------|----------|
| `workers/mcp-clawso/src/handlers/deploy.ts` line ~116 | Slug format: `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/` | `tool_slug` must match this regex |
| `workers/mcp-clawso/src/handlers/deploy.ts` line ~121 | Timeout: 5-60s | `execution_timeout_seconds` range |
| `workers/mcp-clawso/src/handlers/deploy.ts` line ~169 | Reads `manifest.json` from ZIP | Filename must be `manifest.json` |
| `workers/mcp-clawso/src/handlers/deploy.ts` line ~180 | Validates `slug`, `entry_point`, `timeout_seconds`, `allowed_hosts` | Manifest fields must be present |

### Manifest skill

| File | Relationship |
|------|-------------|
| `skills/manifest/SKILL.md` | Downstream consumer — takes importer output and creates the actual fork + deploy artifact |
| `skills/manifest/scripts/prepare_manifest_repo.py` | Forks repo under `clawso-manifest-gen` account |

## Troubleshooting Guide

### Classifier outputs UNCERTAIN for a clearly stateless tool

**Check:** Does the repo use any Cat 4 signal packages (express, fastapi, flask, ws, etc.) as dev dependencies only? The classifier checks `package.json` / `requirements.txt` without distinguishing dev vs prod dependencies.

**Fix:** User should manually confirm with `"confirm cat2"`. Consider updating the classifier to check `devDependencies` separately.

### Wrapper annotates too many lines for removal

**Check:** Rule W2-2 scans for string matches (`openai`, `anthropic`, etc.) which may appear in comments, variable names, or unrelated contexts.

**Fix:** Human reviewer should check each `// CLAWSO: REMOVE` annotation. The wrapper intentionally over-flags rather than under-flags — false positives are safer than false negatives.

### Submission fails with field validation error

**Check against this mapping:**

| JSON field | DB column | Notes |
|------------|-----------|-------|
| `submission_type` | `submission_type` | Must be `'external_mcp'` |
| `source_platform` | `source_platform` | No fixed enum in DB; check BFF validation |
| `source_url` | `source_url` | — |
| `target_slug` | `target_slug` | Must match deploy.ts slug regex |
| `pricing_type` | `price_type` | **Name differs** — JSON uses `pricing_type`, DB uses `price_type` |
| `initial_price_points` | mapped via router | Check `router.mjs` ~line 1983 |
| `author_id` | `author_id` | Must be `null` for external |
| `private_backend_removed` | `scan_results` JSONB | **Not a top-level column** |

### Manifest rejected by deploy pipeline

1. **Wrong filename?** Must be `manifest.json`, not `mfp_manifest.json`
2. **Missing fields?** Deploy.ts requires: `slug`, `entry_point`, `timeout_seconds`, `allowed_hosts`
3. **Slug format?** Must match `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/` — no leading/trailing hyphens, no uppercase
4. **Timeout out of range?** Must be 5-60 for external tools
5. **Entry point missing?** The file referenced by `entry_point` must exist in the ZIP and export `execute()`

### Tool deployed but does not work

1. **LLM calls still present?** Check if `// CLAWSO: REMOVE` annotations were resolved — `user_llm` mode forbids tool-side LLM calls
2. **Private backend unreachable?** If `has_private_backend` was `true`, the original developer's backend may be down or access-restricted
3. **Stateful variable?** If `// CLAWSO: REVIEW` annotations for W2-5 were not resolved, the tool may fail on second+ calls due to cold-start clearing module state

### Cat 4 override (`force cat2`) causes deployment failure

The `force cat2` override bypasses the classifier's Cat 4 block. If the tool genuinely requires persistent state (DB, WebSocket, daemon), it will fail at runtime even if the wrapping and deploy succeed. Common symptoms:
- Tool works on first call, fails on subsequent calls (state not persisted)
- Tool hangs or times out (waiting for a connection that Workers don't support)
- Tool returns empty results (DB queries return nothing in stateless environment)

## PRD Source Documents

The skill was derived from these PRDs. Consult them for field-level definitions if the skill instructions are ambiguous.

| Document | Relevant sections |
|----------|-------------------|
| `CLAWSO_PRD_MVP_v1_0.docx` | Tool types (TUP/MFP), source_origin values, pricing mechanism, tool_submission fields |
| `CLAWSO_MCP_Server_PRD_MVP_v1_0.docx` | MFP execute() contract, ToolContext, ToolResult, allowed_hosts rules, user_llm constraints |
| `CLAWSO_Admin_PRD_MVP_v1_0.docx` | External tool import form fields, submission_type values, Semgrep scan flow, audit checklist |
| `verify_CLAWSO_PRD_MVP_v1_0.docx` | /v1/check call contract, tool_slug format, tool_type enum |
| `clawso_strategic_direction.docx` | Cat 1/2/4 taxonomy (Section 1.1 table) |
