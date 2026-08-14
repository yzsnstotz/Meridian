---
name: dispatch
description: Use when starting a Meridian agent-dispatcher job, running a PRD through the investigate to TaskSpec to dispatch pipeline, or asking for dispatcher flags/defaults/templates.
version: 1.4.0
---

# Dispatch

Start a Meridian agent-dispatcher run, with optional upstream preparation. `$dispatch` can now operate as either:

- **Dispatch-only**: launch from existing TaskSpec artifacts.
- **Pipeline orchestration**: run `$investigate` when needed, then `$taskspec`, then the dispatcher.

The bundled Python runner still launches only existing TaskSpec artifacts. Stage-selection flags such as `--investigate`, `--taskspec<...>`, and `--all` are **skill-level flags**: interpret them before invoking `scripts/dispatch.py`, and do not forward them to the runner.

## Meridian Boundary

Meridian orchestration is not a CCB surface. Do not run `ccb-ping`, do not run `ccb-mounted`, do not inspect `.ccb/`, and do not use CCB provider/session state to diagnose, unblock, dispatch, or protect a Meridian round. Use only Meridian-roles APIs/tools, dispatch lifecycle artifacts, the Hub/agent process logs referenced by Meridian, and the configured `agent_type`/`mode`.

## Canonical Round Layout (v1.19+, four sub-folders)

As of `$taskspec` v1.19.0 and `$investigate` v1.3.0, the pipeline emits one **round directory** per round, with four canonical sub-folders — one per stage. The reference example is `/Users/yzliu/work/Docs/Projects/mumu/branch/category-workbench-2026-05-26/`:

```
<Docs root>/branch/<taskspec-id>/
├── prd/          # /brainstorming output (PRD / design doc). May also hold hand-written PRDs.
├── investigate/  # /investigate output (investigation_report.md, optional discriminator suffix)
├── taskspec/     # /taskspec dispatch artifacts (index.md, dispatch_plan.md, dispatch_command.md, <WORKER>.md, pm_playbook.md, reports/...)
└── test/         # HUMAN-check territory: PM-authored Chinese test guide + post-test reports
```

`$dispatch` MUST honor this layout end-to-end:

1. **Resolving inputs.** When the user supplies a round directory or a TaskSpec directory, accept either form: `<Docs root>/branch/<taskspec-id>/` (round directory — auto-resolve to its `taskspec/` sub-folder), `<Docs root>/branch/<taskspec-id>/taskspec/` (TaskSpec directory directly), or a direct `dispatch_plan.md` path. The legacy flat layout (`branch/<taskspec-id>/dispatch_plan.md` at the round-directory root) is still accepted for already-generated TaskSpecs that predate v1.19.0 — never silently migrate them.
2. **Stage outputs.** When orchestrating the pipeline, route each stage to its canonical sub-folder: `$investigate` writes to `<round>/investigate/`, `$taskspec` writes to `<round>/taskspec/` and `<round>/test/` (the latter for the mandatory Chinese test guide). Never let an upstream stage write into another stage's sub-folder.
3. **PRD location.** When invoking `$investigate` or `$taskspec`, prefer PRDs found at `<round>/prd/*.md` if the user did not name an explicit absolute path. Hand-written PRDs at other paths remain valid and are passed through.
4. **`test/` is human territory.** `$dispatch` does NOT write into `test/` directly. The mandatory Chinese test guide is `$taskspec`'s responsibility. Any post-test report (e.g. `<...>-test-report-<date>.md`) is HUMAN-written; the dispatcher must surface its existence (if present) in run summaries but never modify it.

When operating in dispatch-only mode, this layout is informational — the runner only needs a dispatch plan path. When orchestrating multiple stages, the layout is load-bearing: each stage's output becomes the next stage's input via the sub-folder convention.

## Stage Selection

When the user invokes `$dispatch`, first classify the input:

| Input | Default behavior |
|---|---|
| Existing TaskSpec directory (`<round>/taskspec/`), round directory (`<round>/`), or `dispatch_plan.md` | Dispatch-only. Auto-resolve round-directory inputs to the `taskspec/` sub-folder. |
| PRD / requirements with clear implementation paths | Run `$taskspec --meridian --assign-codex`, then dispatch. Output lands at `<round>/taskspec/` + `<round>/test/`. |
| PRD / requirements with symptom-level bugs or unknown root causes | Run `$investigate` (writes to `<round>/investigate/`), then `$taskspec --meridian --assign-codex` (writes to `<round>/taskspec/` + `<round>/test/`), then dispatch. |

Explicit flags override the default:

| Flag | Meaning |
|---|---|
| `--investigate` | Include the `$investigate` stage. If used alone, stop after the Investigation Report unless `--taskspec`, `--dispatch`, or `--all` is also present. |
| `--taskspec` | Include the `$taskspec` stage. Default arguments for Meridian dispatch are `--meridian --assign-codex`. |
| `--taskspec<...>` | Include `$taskspec` with the exact flags inside the angle brackets, e.g. `--taskspec<--meridian --assign-codex>`. |
| `--dispatch` | Include the final dispatcher launch stage. |
| `--all` | Run the full chain in dependency order: investigation when required or forced, TaskSpec generation, then dispatch. |
| `--codex-para` / `codex-para` | Use the Codex parallel dispatch profile for the final launch. If a saved template named `codex-para` exists, pass `--codex-para` to `scripts/dispatch.py`; otherwise use explicit Codex parallel flags. |

If any explicit stage flags are present, run exactly those selected stages plus any unavoidable prerequisite the user approves. Do not silently dispatch stale artifacts when the selected upstream stage produced newer output.

## Pipeline Quick Start

Full PRD-to-dispatch flow, using investigation if the PRD has unknown root causes:

```text
$dispatch --all --codex-para /absolute/path/to/fix_prd.md
```

Investigation only:

```text
$dispatch --investigate /absolute/path/to/fix_prd.md
```

Generate Meridian/Codex TaskSpec artifacts, then stop:

```text
$dispatch --taskspec<--meridian --assign-codex> /absolute/path/to/prd.md
```

Generate TaskSpec artifacts and dispatch them with the Codex parallel profile:

```text
$dispatch --taskspec<--meridian --assign-codex> --dispatch --codex-para /absolute/path/to/prd.md
```

Dispatch existing artifacts only — any of the following input shapes work:

```text
$dispatch /absolute/path/to/round-dir --codex-para                    # round dir; auto-resolves to <round>/taskspec/
$dispatch /absolute/path/to/round-dir/taskspec --codex-para           # explicit TaskSpec dir under round dir
$dispatch /absolute/path/to/round-dir/taskspec/dispatch_plan.md --codex-para   # direct plan path
$dispatch /absolute/path/to/legacy-flat-dir --codex-para              # legacy v1.18-and-earlier flat layout (no taskspec/ sub-folder)
```

## Pipeline Workflow

1. **Resolve intent and input type.** Determine whether the user supplied existing dispatch artifacts, a TaskSpec directory, a round directory, an Investigation Report, a PRD, or rough requirements. If the user supplied a round directory (`<Docs root>/branch/<taskspec-id>/`), auto-resolve sub-folders: PRD inputs from `<round>/prd/`, investigation reports from `<round>/investigate/`, TaskSpec artifacts at `<round>/taskspec/`, human test guide at `<round>/test/`.
2. **Investigate when selected or required.** If `--investigate` is present, or the PRD contains symptom-level issues with unknown root causes, invoke the `$investigate` skill first. Its Investigation Report writes to `<round>/investigate/investigation_report.md` (canonical v1.3.0 path; legacy `<round>/investigation_report_*.md` is still readable but not produced). Use the investigate skill's path-confirmation contract.
3. **Generate TaskSpec when selected or required.** If `--taskspec`, `--all`, or a PRD-without-artifacts path is present, invoke `$taskspec` with `--meridian --assign-codex` unless the user supplied explicit `--taskspec<...>` arguments. If an Investigation Report exists, feed it to `$taskspec` alongside the PRD. `$taskspec` v1.19.0+ writes its dispatch artifacts to `<round>/taskspec/` and ALSO writes a mandatory Chinese test guide to `<round>/test/<YYYY-MM-DD>-<project>-<branch-feature>-test-guide.md`. Verify both surfaces exist before proceeding to dispatch.
4. **Validate dispatch artifacts.** Confirm the TaskSpec directory (`<round>/taskspec/` for v1.19+; `<round>/` for legacy flat layout) contains `dispatch_plan.md` and either `agent_dispatch_command.md` or `dispatch_command.md`. Also confirm `<round>/test/` contains at least one `*-test-guide.md` file for v1.19+ rounds; if absent, flag it as a generation gap (re-run `$taskspec` or ask user) — do not silently dispatch.
5. **Run the dispatch preflight reconciler.** Before launching, inspect the artifacts for GIT-mode terminal safety:
   - Resolve the configured PR base branch from `dispatch_command.md` or the plan. If it is not `main`, pass the same branch to the dispatcher as `--validator-base-branch <base>` unless a template already pins it.
   - For GIT-mode plans with code/validation PRs, rollup/stack PRs, or 2+ non-teardown rows, verify an `INTEGRATE` row exists immediately before `POST-FLIGHT`.
   - Verify `POST-FLIGHT` is the last row and does not own first-time merge/check-wait duties; missing `INTEGRATE` in a current TaskSpec is a pre-launch artifact blocker unless the plan explicitly documents the single-row doc-only/no-code omission.
   - List existing open PRs whose head branch or title contains the TaskSpec ID. If open PRs already exist before launch, record them in the operator notes and do not assume POST-FLIGHT will clean them up; the `INTEGRATE` row must own them.
6. **Run the Worktree Topology Sanity Check.** Cross-validate the TaskSpec's worktree topology against the dispatcher's parallel config. See the dedicated section below; this gate refuses to launch a parallel dispatcher on a shared-worktree TaskSpec.
7. **Dry-run unfamiliar launches.** Run the bundled dispatch runner with `--dry-run` before starting a new or regenerated plan.
8. **Launch.** Strip skill-level flags and invoke `scripts/dispatch.py` with the resolved TaskSpec path plus dispatch-runner flags/templates.
9. **Capture follow-up IDs.** Read the JSON result and record `dispatcher_id` and `dispatcher_thread_id`.

## Worktree Topology Sanity Check (mandatory pre-launch gate)

**Why this gate exists:** as of `$taskspec` v1.21.0, TaskSpecs can be generated in one of two worktree topologies:

- **Shared TaskSpec worktree** (`$taskspec` default, no `--parallel` flag): every worker file's `**Repo**:` points at the same `<repo-root>/.worktrees/<taskspec-id>` path. Safe only when the dispatcher runs serial (`parallel_dispatch.enabled=false` or `max_concurrency=1`).
- **Per-worker worktrees** (`$taskspec --parallel`): each implementation worker's `**Repo**:` points at its own `<repo-root>/.worktrees/<taskspec-id>-<WORKER_ID>`; BATCH/V/INTEGRATE workers share `<repo-root>/.worktrees/<taskspec-id>-integration`. Required when the dispatcher runs parallel (`max_concurrency > 1`, including any `--codex-para` invocation).

Mixing these — parallel dispatcher + shared worktree — produces concurrent `git checkout` / `.git/index.lock` / `node_modules` / `target/` races inside a single directory. meridian-roles' `role-handlers.ts:970-1059` (`continue-dispatcher`) launches multiple dependency-eligible workers concurrently when `parallel_dispatch.enabled=true`, and `continue-worker.ts:262-269` (`resolveLaunchSpawnDir`) reads each worker's `**Repo**:` field independently as that subprocess's `cwd`. If all `**Repo**:` paths point at the same directory, every concurrent worker subprocess fights for the same git index. The lifecycle's `thread-id-reservation` is per-worker, not per-TaskSpec — it does NOT serialize co-resident workers.

**The gate runs at Pipeline Workflow step 6, before `--dry-run`:**

1. **Parse the resolved dispatch config** (the merged `defaults + template + explicit flags` payload). Extract `parallel_dispatch.enabled` and `parallel_dispatch.max_concurrency`. If both are absent, the dispatcher will use `max_concurrency=1` (serial).
2. **Parse every worker file's `**Repo**:` field** under the resolved TaskSpec directory. Collect:
   - The set of unique absolute paths.
   - The mapping of `<WORKER_ID>` → `**Repo**:` path.
3. **Detect topology**:
   - **Shared**: every implementation worker (`R-*`, `N-*`, `D-*`) has the SAME `**Repo**:` path matching `<repo-root>/.worktrees/<taskspec-id>` exactly (POST-FLIGHT is excepted — it points at `<repo-root>` by design).
   - **Per-worker**: every implementation worker has a DISTINCT `**Repo**:` matching `<repo-root>/.worktrees/<taskspec-id>-<WORKER_ID>`; BATCH/V/INTEGRATE workers share `<repo-root>/.worktrees/<taskspec-id>-integration`.
   - **Mixed / non-conformant**: anything else (some workers shared, some per-worker; paths that don't fit either pattern; missing `**Repo**:` field).
4. **Apply the compatibility matrix**:

   | Dispatcher mode | TaskSpec topology | Action |
   |---|---|---|
   | serial (`max_concurrency=1` or unset) | shared | ✅ accept |
   | serial | per-worker | ✅ accept with warning ("per-worker worktrees on serial dispatch — wasted disk; consider regenerating without `--parallel`") |
   | serial | mixed/non-conformant | ⛔ refuse; surface the offending workers |
   | parallel (`max_concurrency>1`) | shared | ⛔ **REFUSE TO LAUNCH** — emit the diagnostic below |
   | parallel | per-worker | ✅ accept |
   | parallel | mixed/non-conformant | ⛔ refuse; surface the offending workers |

5. **Refusal diagnostic format** (when parallel+shared is detected):

   ```
   ⛔ Worktree topology mismatch — refusing to launch.

   Dispatcher config:  parallel_dispatch.enabled=true, max_concurrency=3
   TaskSpec topology:  shared (all worker **Repo**: paths point at
                       <repo-root>/.worktrees/<taskspec-id>)
   Risk:               concurrent workers will race on git index / node_modules
                       / target/ cache inside the shared directory.

   Resolutions (pick one):
     a) Regenerate the TaskSpec with `--parallel`:
        $taskspec --meridian --assign-codex --parallel <PRD path>
        This produces per-worker worktrees safe for parallel dispatch.
     b) Run this dispatcher serially:
        Drop --codex-para (or any --parallel-dispatch-enabled config).
        The shared worktree is safe under max_concurrency=1.
   ```

6. **Refusal exit code:** `/dispatch` returns non-zero and does NOT invoke `scripts/dispatch.py`. No HTTP call to meridian-roles is made. The user must amend either the TaskSpec or the dispatch config and re-invoke.

**Implementation note:** the check is read-only and idempotent — it parses files that already exist on disk and consults the resolved CLI args. It runs even with `--dry-run`. The check applies equally to dispatch-only invocations and full pipeline invocations.

**`codex-para` template implication:** because `codex-para` sets `max_concurrency=3` by default (see line below), every TaskSpec dispatched with `--codex-para` MUST be `--parallel`-generated. The skill SHOULD recommend `$taskspec --meridian --assign-codex --parallel ...` whenever the user names `codex-para` or asks for parallel dispatch. Conversely, when the user supplies a shared-worktree TaskSpec and asks for `codex-para`, the skill SHOULD warn before invoking and offer to either regenerate or drop the parallel flag.

## Dispatch Runner Quick Start

Run the bundled runner:

```bash
python3 /Users/yzliu/work/Docs/skills/dispatch/scripts/dispatch.py <taskspec-dir-or-dispatch-plan>
```

Use `--dry-run` before a risky launch:

```bash
python3 /Users/yzliu/work/Docs/skills/dispatch/scripts/dispatch.py <taskspec-dir> --dry-run
```

The runner accepts a TaskSpec directory (`<round>/taskspec/`), a round directory (`<round>/`, the runner resolves to the `taskspec/` sub-folder), a directory containing `taskspec/`, or a direct `dispatch_plan.md` path. It resolves the command file beside the plan, preferring `agent_dispatch_command.md` and falling back to `dispatch_command.md`. For legacy v1.18.0-and-earlier TaskSpecs that still use the flat layout (`<round>/dispatch_plan.md` at the round-directory root), the runner accepts the round directory directly without descending into `taskspec/` — the resolution rule is "look for `dispatch_plan.md` beside the supplied path first, then under `<path>/taskspec/`".

### Codex Parallel Profile

`codex-para` is the preferred shorthand for Codex parallel dispatch. Prefer a saved template when available:

```bash
python3 /Users/yzliu/work/Docs/skills/dispatch/scripts/dispatch.py <taskspec-dir> --codex-para
```

If no saved `codex-para` template exists, use explicit runner flags:

```bash
python3 /Users/yzliu/work/Docs/skills/dispatch/scripts/dispatch.py <taskspec-dir> \
  --agent-type codex \
  --pm-agent-type codex \
  --validator-agent-type codex \
  --parallel-dispatch-enabled \
  --parallel-dispatch-max-concurrency 3
```

> **⚠️ Worktree topology prerequisite (v1.21.0):** `codex-para` sets `max_concurrency=3`, which means meridian-roles will launch up to 3 dependency-eligible workers **concurrently in the same TaskSpec** (per `role-handlers.ts:970-1059`). Each worker subprocess spawns with its own worker file's `**Repo**:` as `cwd`. If every worker's `**Repo**:` points at the same shared TaskSpec worktree (the `$taskspec` default, no `--parallel` flag), the concurrent subprocesses will race on `git checkout`, `.git/index.lock`, `node_modules`, and `target/`. **The TaskSpec MUST be generated with `$taskspec --parallel`** (per-worker worktrees) before `codex-para` is safe. The Worktree Topology Sanity Check (Pipeline Workflow step 6) enforces this and refuses to launch on mismatch — but generate the TaskSpec correctly up front rather than getting bounced at launch:
>
> ```bash
> $taskspec --meridian --assign-codex --parallel <PRD path>     # generate per-worker worktree TaskSpec
> $dispatch <round-dir> --codex-para                            # safe parallel dispatch
> ```

To make the shorthand durable, save it once:

```bash
python3 /Users/yzliu/work/Docs/skills/dispatch/scripts/dispatch.py \
  --save-template codex-para \
  --agent-type codex \
  --pm-agent-type codex \
  --validator-agent-type codex \
  --parallel-dispatch-enabled \
  --parallel-dispatch-max-concurrency 3
```

## Templates

Use templates when the user wants `$dispatch` to remember a repeatable dispatcher profile, such as reply channels, agent type, model IDs, PM/validator settings, service URL, or model-map overrides.

Templates are stored in `$MERIDIAN_DISPATCH_TEMPLATE_STORE`, else `~/.config/meridian/dispatch_templates.json`.

Save explicitly provided dispatcher flags as a template:

```bash
python3 /Users/yzliu/work/Docs/skills/dispatch/scripts/dispatch.py \
  --save-template ops \
  --reply-channel web:ops \
  --agent-type codex \
  --parallel-dispatch-enabled \
  --parallel-dispatch-max-concurrency 3 \
  --validator-base-branch main
```

Apply the template with `--template <name>` or shorthand `--<name>`:

```bash
python3 /Users/yzliu/work/Docs/skills/dispatch/scripts/dispatch.py <taskspec-dir> --ops --dry-run
```

Built-in defaults are applied first, then templates, then explicit CLI flags. This means one-off flags override the saved template:

```bash
python3 /Users/yzliu/work/Docs/skills/dispatch/scripts/dispatch.py <taskspec-dir> --ops --agent-type claude
```

Manage templates without launching a dispatcher:

```bash
python3 /Users/yzliu/work/Docs/skills/dispatch/scripts/dispatch.py --list-templates
python3 /Users/yzliu/work/Docs/skills/dispatch/scripts/dispatch.py --show-template ops
python3 /Users/yzliu/work/Docs/skills/dispatch/scripts/dispatch.py --delete-template ops
```

Template names must start with a letter or number and contain only letters, numbers, `-`, or `_`. If a template name conflicts with a built-in flag such as `dry-run`, use `--template <name>` instead of the shorthand.

## Defaults

When flags are absent, use the proven Codex dispatcher profile:

| Setting | Default |
|---|---|
| Service URL | `$MERIDIAN_ROLES_HTTP`, else `http://127.0.0.1:7701` |
| Dispatcher agent | `codex`, `bridge`, `kill_policy=always` |
| Dispatcher auto approve | `true` |
| Reply channels | `/api/channels`, else `web:ops` fallback |
| PM resolver | enabled, `codex`, `bridge`, auto approve `true` |
| Validator | enabled, `codex`, `stateless_call`, binary threshold, max fix cycles `5`, base branch inferred from TaskSpec (`main` only when the TaskSpec base is main) |
| Model IDs | omitted unless flags provide them, so Hub/provider defaults can evolve |

Ask the user only for settings that cannot be discovered safely, such as a non-default reply channel, a required credential, an unusual base branch, or whether validator/PM should be disabled.

## Common Flags

Run `scripts/dispatch.py --help` for the full runner flag list. These flags are passed only to the final dispatch launch:

- `--plan <path>`: explicit dispatch plan path.
- `--command <path>`: explicit command file path.
- `--repo-root <path>` / `--docs-root <path>`: override Meridian path inference.
- `--reply-channel '<json-or-shorthand>'`: repeatable; examples: `web:ops`, `telegram:6137086342`, or JSON.
- `--agent-type claude|codex|gemini|cursor`, `--model-id <id>`.
- `--no-auto-approve`.
- `--no-pm`, `--pm-model-id <id>`, `--pm-agent-type <type>`.
- `--no-validator`, `--validator-model-id <id>`, `--validator-base-branch <branch>`.
- `--model-map 'CODE=provider:model_id,...'` or `--model-map-file <json>`.
- `--parallel-dispatch-enabled`, `--no-parallel-dispatch`, `--parallel-dispatch-max-concurrency <int>`.
- `--save-template <name>`, `--list-templates`, `--show-template <name>`, `--delete-template <name>`.
- `--template <name>` or `--<name>`: apply a saved dispatcher template.
- `--dry-run`: resolve and print the payload without starting a dispatcher.

Do not pass skill-level stage flags (`--investigate`, `--taskspec`, `--all`, `--dispatch`) to `scripts/dispatch.py`; the runner will treat unknown long flags as template names.

## Dispatch-Only Workflow

1. Resolve the TaskSpec artifacts and run `--dry-run` if the target is unfamiliar.
2. Check the resolved plan and command path. Do not rename command files just to satisfy `meridian-tool dispatch-start`; this runner calls `/api/agent-dispatcher/start` directly and supports both command filenames.
3. Run the preflight reconciler described in Pipeline Workflow step 5: infer validator base branch, verify `INTEGRATE` before `POST-FLIGHT` for GIT-mode code rounds, and surface any pre-existing TaskSpec PRs before launch.
4. Run the Worktree Topology Sanity Check (Pipeline Workflow step 6). If the resolved dispatcher config is parallel (`max_concurrency>1`, including any `--codex-para` invocation), refuse to launch unless every implementation worker's `**Repo**:` field points at a distinct `<repo-root>/.worktrees/<taskspec-id>-<WORKER_ID>` path.
5. Start the dispatcher with the runner.
6. Read the JSON result. Capture `dispatcher_id` and `dispatcher_thread_id`.
7. Use the Meridian control tools for follow-up:

```bash
node /Users/yzliu/work/Meridian/Meridian-roles/dist/bin/meridian-tool.js dispatch-status --plan <dispatch_plan.md>
node /Users/yzliu/work/Meridian/Meridian-roles/dist/bin/meridian-tool.js continue-dispatcher --dispatcher <dispatcher_id>
```

## Blocked-Run Reconciler

When a running dispatcher is stuck at `INTEGRATE`, `POST-FLIGHT`, a validator, or a PM resolver, do not immediately ask the user to intervene. First run a non-mutating reconciliation pass that classifies whether the run is waiting on GitHub/CI state that the dispatch layer can resolve.

1. Read current lifecycle state:

```bash
node /Users/yzliu/work/Meridian/Meridian-roles/dist/bin/meridian-tool.js dispatch-status --plan <dispatch_plan.md>
```

2. If the blocked row is `POST-FLIGHT`, check whether `INTEGRATE` actually completed. POST-FLIGHT blockers caused by open PRs, pending checks, missing merge SHA, or undeleted TaskSpec branches are `INTEGRATE incomplete`; resume or repair `INTEGRATE`, then `continue-dispatcher`. Do not make POST-FLIGHT perform first-time merge work.
3. For the TaskSpec ID, list PRs and classify them:
   - `MERGED`: verify merge commit is contained in `origin/<PR-base-branch>`.
   - `OPEN` with pending checks: watch checks until pass/fail or timeout; if pass and the row owns merge authority, merge from the verified head SHA.
   - `OPEN` and superseded by a merged rollup: comment, close, and delete the remote branch only after confirming the commits are represented in the merged base.
   - `CLOSED` unmerged: verify it is intentionally superseded before deleting branches.
4. Treat the GitHub CLI error `base branch is already used by worktree` after `gh pr merge` as an ambiguous local cleanup error, not proof the merge failed. Confirm with `gh pr view <pr> --json state,mergedAt,mergeCommit` before retrying or escalating.
5. If reconciliation changes lifecycle truth, use meridian-tool rather than editing files:

```bash
node /Users/yzliu/work/Meridian/Meridian-roles/dist/bin/meridian-tool.js update-status --plan <dispatch_plan.md> --worker <WORKER_ID> --status completed
node /Users/yzliu/work/Meridian/Meridian-roles/dist/bin/meridian-tool.js continue-dispatcher --dispatcher <dispatcher_id>
```

6. Escalate to the user only when the reconciler finds a real external blocker: failing required checks with no obvious fix, missing approval, unresolved merge conflicts, missing credentials, or a law/PM decision conflict.

## Safety Rules

- Respect the four-folder round layout. Never write `$investigate` output into `<round>/taskspec/`, never write `$taskspec` output into `<round>/investigate/` or `<round>/prd/`, and never write any dispatch-generated content into `<round>/test/` (test guide is `$taskspec`'s responsibility; everything else in `test/` is HUMAN-owned). Do not silently migrate a legacy flat-layout TaskSpec to the new layout — let in-flight rounds finish under the layout they were generated under.
- Respect the dependency chain. Do not run `$taskspec` before `$investigate` when the PRD has unknown root causes, unless the user explicitly waives investigation.
- Do not launch a dispatcher from older artifacts after generating a newer Investigation Report or TaskSpec in the same turn.
- Do not launch a GIT-mode code TaskSpec that lacks an `INTEGRATE` row before `POST-FLIGHT`, unless it explicitly documents the single-row doc-only/no-code omission.
- Do not let POST-FLIGHT become a merge worker. If POST-FLIGHT is blocked by PR/check/base-branch state, repair or resume `INTEGRATE`.
- Do not launch a parallel dispatcher (`parallel_dispatch.enabled=true && max_concurrency>1`, including any `--codex-para` invocation) against a shared-worktree TaskSpec. The Worktree Topology Sanity Check refuses this combination; do not bypass it. Either regenerate the TaskSpec with `$taskspec --parallel` (per-worker worktrees) or drop the parallel flags.
- Do not leave the validator on default `main` when the TaskSpec PR base branch is another branch; infer or pass `--validator-base-branch <base>`.
- Treat `--taskspec<...>` as a TaskSpec-stage argument list, not as shell syntax for `scripts/dispatch.py`.
- Never edit `dispatch_plan.md` or `dispatch_threads.json` manually during launch.
- Do not bypass Meridian's service-owned worker selection with raw `spawn` or `run`.
- If a row is already running, use `dispatch-status` and `continue-dispatcher`; do not start a duplicate dispatcher for the same plan unless the user explicitly asks.
- If the plan has no parseable rows, fix the TaskSpec artifacts before starting. Meridian requires a Markdown table with `Status`, `Batch`, and `Worker` columns.
