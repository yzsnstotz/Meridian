---
name: manifest
description: Create a clawso-compatible GitHub fork for an external MCP tool by using the dedicated GitHub account `clawso-manifest-gen`, adapting the repo to the current clawso deploy contract, generating `manifest.json`, committing and pushing the required files, and returning the dealt GitHub URL plus the exact admin-form values to use.
---

# Manifest

Use this skill when the user wants a GitHub repo adapted into a clawso-ready external MCP source repo.

The output of this skill is a dealt forked repo that admin can submit through clawso's external tool intake flow.

## Current clawso contract

Read only the files you need:

- `/Users/yzliu/work/projects/clawso/workers/mcp-clawso/src/handlers/deploy.ts`
- `/Users/yzliu/work/projects/clawso/src/bff/integrations.mjs`
- `/Users/yzliu/work/projects/clawso/src/bff/router.mjs`
- `/Users/yzliu/work/projects/clawso/src/bff/archive.mjs`
- `/Users/yzliu/work/projects/clawso/docs/dev/reports/2026-03-18-manifest-prd-delta.md`

Today, the deploy path requires a repo ZIP that contains:

- `manifest.json`
- an `entry_point` file referenced by that manifest
- an exported `execute` function in that entry file

The manifest slug must exactly match the slug that admin will submit in clawso.

## GitHub account source

Always use the dedicated GitHub account token stored in:

- `/Users/yzliu/.config/gh/hosts.yml`

Use the additional account key:

- `clawso-manifest-gen`

Do not print the token. Read it from disk and pass it through environment variables or authenticated API requests only.

## Workflow

1. Run `scripts/prepare_manifest_repo.py <repo-url>` to:
   - parse the source repo
   - read the `clawso-manifest-gen` token from `hosts.yml`
   - resolve the actual GitHub login behind that token
   - ensure the fork exists under that resolved GitHub login
   - clone the fork locally using a shallow sparse clone by default
   - print JSON with source/fork metadata and default manifest values
2. Inspect the forked repo code before editing anything important.
3. Decide whether the repo can be adapted safely to clawso's current MCP contract.
4. If adaptation is straightforward, make additive changes only:
   - prefer a root `manifest.json`
   - prefer a new wrapper file like `clawso/index.js` as `entry_point`
   - avoid invasive upstream rewrites when a wrapper is enough
5. Ensure the final adapter exports a real `execute` function.
6. Populate `manifest.json` with at least:
   - `slug`
   - `entry_point`
   - `timeout_seconds`
   - `allowed_hosts`
7. Commit and push to the fork.
8. Return the dealt repo URL and the exact clawso admin-form values:
   - source URL
   - slug
   - title
   - package URL if one should be used instead of source URL
   - entry point path
   - allowed hosts summary

## Rules

- Do not create a fake placeholder adapter that only satisfies deploy checks but does not implement the tool.
- If the repo cannot be adapted confidently, stop and report the blocker instead of pushing a misleading fork.
- If the source repo lookup returns GitHub `404`, stop and ask the user to verify the exact owner/repo path. Do not guess likely alternatives.
- Keep clawso-specific files isolated when possible, for example under `clawso/`.
- Preserve license and attribution files from upstream.
- Prefer explicit hostnames in `allowed_hosts`; do not use broad wildcards.
- Default `timeout_seconds` to `25` unless the code clearly needs another value.
- When a repo already exposes a compatible function, point `entry_point` to a thin wrapper instead of rewriting the project.

## Practical guidance

Good manifest generation inputs can be derived from repo metadata:

- `title`: repo name or project display name
- `description`: repo description plus a short clawso-specific summary if needed
- `slug`: explicit user/admin target slug first, otherwise slugified repo name

Do not rely on repo metadata alone for:

- `entry_point`
- `allowed_hosts`
- true MCP compatibility

Those require code inspection.

## Helper Notes

- The account key `clawso-manifest-gen` is a token alias, not necessarily the GitHub username.
- At the moment, the token resolves to GitHub login `nobuaki8366`.
- The helper script should treat the resolved `/user.login` as the fork owner and report that in its JSON output.

## Output contract

At the end, provide:

- dealt repo URL
- exact admin `source_url` to paste into clawso
- exact `slug` to use in clawso
- files added or changed in the fork
- any assumptions or residual risks
