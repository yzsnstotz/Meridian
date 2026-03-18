---
name: clawso-tool-importer-wrapper
description: >
  Sub-skill of clawso-tool-importer. Adapts an external repository's code to
  Clawso's standard tool format based on confirmed category (Cat 1 TUP or
  Cat 2 MFP). Called by the orchestrator after user confirms category; do not
  trigger independently.
---

# Code Wrapper

Adapt the external repository's code to Clawso's standard tool format. This sub-skill annotates code for human review — it never deletes original code.

## Input

Receives from orchestrator shared_state:
- `repo_url` — the repository
- `confirmed_category` — `"cat1"` or `"cat2"`
- `tool_slug` — confirmed slug
- `has_private_backend` — from classifier

## Core Principle

**Annotate, never delete.** All changes are additive. Original code is preserved with `// CLAWSO:` annotations marking lines that need human attention before submission.

## Cat 2 (MFP) Wrapping Rules

Apply all of the following rules when wrapping a Cat 2 tool:

### Rule W2-1 — Function signature

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

### Rule W2-2 — LLM API calls forbidden

Scan for any calls to: `openai`, `anthropic`, `claude`, `gpt`, `llm`, `ChatCompletion`, `messages.create`.

If found: add a `// CLAWSO: REMOVE -- LLM calls not permitted in user_llm mode` annotation on each line. Do not delete — annotate for human review.

### Rule W2-3 — allowed_hosts extraction

Scan all `fetch()`, `axios.get/post`, `http.request`, `got()`, `node-fetch`, `undici` calls. Extract every unique domain called.

Output as a list: these become the `allowed_hosts` array in the manifest.

Flag any domain that is not a well-known public API (e.g. not `api.github.com`, `api.openai.com`, etc.) with `// CLAWSO: REVIEW -- confirm this domain is intentional`.

> **Known gap:** `allowed_hosts` extraction is for admin review only; runtime enforcement is handled separately by the Worker template. The current Worker does not wrap fetch calls to enforce domain whitelisting. This extraction ensures admin reviewers have visibility into external calls.

### Rule W2-4 — No platformApiKey

If any reference to `context.platformApiKey` exists, annotate: `// CLAWSO: REMOVE -- platformApiKey does not exist in MVP`.

### Rule W2-5 — No cross-call state

If any module-level mutable variables are used to persist state between calls (e.g. `let cache = {}` at module scope that is written to during execution), annotate: `// CLAWSO: REVIEW -- stateful variable, violates stateless execution model`.

### Rule W2-6 — Timeout declaration

If the tool's README or code suggests it may run longer than 30 seconds, add a comment at the top of the execute function:

```typescript
// CLAWSO: Declare timeout in manifest if execution may exceed 30s (max 60s for external tools)
```

External tools support a timeout range of 5-60 seconds (wider than first-party 5-30s range).

## Cat 1 (TUP) Wrapping Rules

Apply all of the following rules when wrapping a Cat 1 tool:

### Rule W1-1 — Verification hook

Add a comment block at the top of the main entry script:

```python
# CLAWSO TUP INTEGRATION REQUIRED:
# Before executing any logic, call verify.clawso.ai/v1/check with:
#   user_token, tool_slug, tool_type="tup", os_type, sdk_version, device_fingerprint
# Proceed only if response.valid == true
# See: verify.clawso.ai PRD section 2.2 for full request schema
```

### Rule W1-2 — Offline guard

Add a comment where the main execution begins:

```python
# CLAWSO: This tool requires network connectivity. If verify call fails,
# display error message and do not allow offline execution.
```

### Rule W1-3 — Cython protection note

Add at end of file:

```python
# CLAWSO: Key verification logic must be compiled with Cython before packaging.
# See TUP packaging guide for Cython compilation and PyInstaller bundling steps.
```

## Wrapper Output

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
**LLM API calls found**: Yes [warning] / No [confirmed]
**Stateful variables found**: Yes [warning] / No [confirmed]

Human actions required before submission:
- [ ] Remove or replace all `// CLAWSO: REMOVE` lines
- [ ] Review all `// CLAWSO: REVIEW` lines and confirm intent
- [ ] Confirm allowed_hosts list is complete and correct
```
