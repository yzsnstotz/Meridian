---
name: clawso-tool-importer-doc-generator
description: >
  Sub-skill of clawso-tool-importer. Generates all submission documents required
  to import an external tool into Clawso: manifest, tool_submission record,
  pricing config, and admin review checklist. Called by the orchestrator after
  wrapping is complete; do not trigger independently.
---

# Document Generator

Generate all submission documents required to import the external tool into Clawso. This sub-skill produces four documents from the collected shared_state and wrapper output.

## Input

Receives the full shared_state from orchestrator plus wrapper output:
- `repo_url`, `tool_slug`, `confirmed_category`, `pricing_type`, `initial_price`
- `license_confirmed`, `has_private_backend`, `source_origin`, `source_platform`
- Wrapper's `allowed_hosts` list
- Wrapper's annotation counts and flags

## Document 1 — `manifest.json` (Cat 2 only)

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

### Field rules

- `slug`: lowercase, hyphens only, matches `tool_slug` from shared_state
- `source_origin`: always `"external"` for imported tools
- `runtime_mode`: always `"user_llm"` — hardcoded, never leave blank. This is an MVP constraint.
- `execution_timeout_seconds`: default 30; set to 60 only if wrapper flagged a timeout warning. Valid range: 5-60 for external tools.
- `allowed_hosts`: populate from wrapper's extracted domain list
- `pricing.type`: from shared_state `pricing_type`
- For `fixed`: `points_per_call` from `initial_price` in shared_state
- For `bonding_curve`: populate `base_price` from `initial_price`; leave `growth_factor` and `period_calls_target` as 0 with a `// TODO` comment — these require developer input
- `params_schema` / `result_schema`: extract from the execute() function's TypeScript types or Python type hints if available; otherwise leave as `{}` with a `// TODO` comment
- `copyright_notice`: always include — this is a compliance requirement

**Note:** This file is named `manifest.json` (not `mfp_manifest.json`) to match the external MCP deploy pipeline in `workers/mcp-clawso/src/handlers/deploy.ts`.

## Document 2 — `tool_submission_record.json`

Maps to the Admin tool import form:

```json
{
  "submission_type": "external_mcp",
  "source_platform": "{auto-detected from URL domain}",
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

### Field rules

- `submission_type`: always `"external_mcp"` for repo imports
- `source_platform`: auto-detected from URL domain (see orchestrator's Source Platform Detection). Not constrained to a fixed enum — any recognizable domain name works, fallback `"other"`.
- `author_id`: always `null` for external tools — external tools do not participate in developer revenue share
- `status`: always `"pending_manual_review"` on creation
- `semgrep_scan_status`: always `"pending"` — scan is triggered server-side after submission
- `private_backend_removed`: set to `false` if wrapper found private backend calls; `true` if none found. This is a human-confirmation field stored in `scan_results` JSONB (not a top-level DB column).
- `license_confirmed`: carry from classifier's `license_confirmed` value in shared_state

## Document 3 — `admin_review_checklist.md`

Generate a filled-in checklist matching the Admin external MCP review items:

```markdown
# Admin Review Checklist -- External MCP Import
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
- [ ] params_schema and result_schema are complete (no empty {})
- [ ] Pricing config reviewed and approved

## Sign-off
Reviewer: _______________  Date: _______________
```

### Pre-fill rules

- Check `[x]` for `License confirmed` only if `license_confirmed = true` in shared_state
- Check `[x]` for `Private backend calls removed` only if `has_private_backend = false` in shared_state
- `Source repo is publicly accessible` should always be `[x]` (verified by classifier reaching the repo)

## Document 4 — `pricing_config_block.json`

Standalone pricing configuration block for the Admin price override UI:

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

## Final Handoff Summary

After generating all four documents, output:

```
## Import Package Complete

Files generated for tool: {tool_slug}

  manifest.json               -- Deploy to mcp.clawso.ai worker config
  tool_submission_record.json -- Submit via Admin -> External Tool Import
  admin_review_checklist.md   -- Attach to Admin review queue ticket
  pricing_config_block.json   -- Reference for Admin price configuration

## TODOs before submission
- [ ] Complete all // TODO fields in manifest.json (params_schema, result_schema)
- [ ] Remove or resolve all // CLAWSO: REMOVE annotations in wrapped code
- [ ] Confirm allowed_hosts list is final
- [ ] Run Semgrep locally before submitting (optional but recommended)
- [ ] Translate tool display name to Chinese if not already done

## Next step
Submit tool_submission_record.json via: Admin -> Tools -> External Tool Import (/admin/tools/import)
After submission, Semgrep scan triggers automatically. Tool enters pending_manual_review queue.
```
