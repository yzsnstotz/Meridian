# PR Review Report — v1_round

## Per-File Verdicts
| File | Worker | Verdict | Notes |
|------|--------|---------|-------|
| `.env.example` | Unplanned | ➕ Unplanned Addition | GUI deep-link query rename is unrelated to the CLI integration PRD/TaskSpec. |
| `CLI.md` | N-03 | ✅ Aligned | Documents all 7 Meridian CLI commands, exit codes, env vars, and examples. |
| `MANUAL.md` | Unplanned | ➕ Unplanned Addition | New general integration manual was not scoped by N-03 or the PRD. |
| `docs/branch/feat-cli-external-integration/.meridian-roles-dispatcher-prompt-feat-cli-external-integration.md` | N-06 / R-05 | ⚠️ Scope Drift | Generated prompt artifact is committed here, but the backing Meridian-roles behavior is outside this PR diff. |
| `docs/branch/feat-cli-external-integration/dev_history/v1_round/N-01_report.md` | N-01 | ✅ Aligned | Expected dispatch artifact. |
| `docs/branch/feat-cli-external-integration/dev_history/v1_round/N-02_report.md` | N-02 | ✅ Aligned | Expected dispatch artifact. |
| `docs/branch/feat-cli-external-integration/dev_history/v1_round/N-04_report.md` | N-04 | ⚠️ Scope Drift | Report committed here, but the backing Meridian-roles code is outside this repo diff. |
| `docs/branch/feat-cli-external-integration/dev_history/v1_round/N-06_report.md` | N-06 | ⚠️ Scope Drift | Report committed here, but the backing Meridian-roles code is outside this repo diff. |
| `docs/branch/feat-cli-external-integration/dev_history/v1_round/PRE-FLIGHT_report.md` | PRE-FLIGHT | ✅ Aligned | Expected dispatch artifact. |
| `docs/branch/feat-cli-external-integration/dev_history/v1_round/R-02_report.md` | R-02 | ✅ Aligned | Expected dispatch artifact. |
| `docs/branch/feat-cli-external-integration/dev_history/v1_round/R-03_report.md` | R-03 | ⚠️ Scope Drift | Report committed here, but the backing Meridian-roles code is outside this repo diff. |
| `docs/branch/feat-cli-external-integration/dispatch_plan.md` | DELTA-CHECK / PR-REVIEW | ⚠️ Scope Drift | Marks `DELTA-CHECK` complete without the required delta report and marks `R-06` complete although its target file was not updated. |
| `docs/branch/feat-cli-external-integration/dispatch_threads.json` | Dispatch Artifact | ➕ Unplanned Addition | Runtime state snapshot is not a PRD deliverable for the Meridian repo. |
| `docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/B1-GATE_report.md` | Unplanned | ➕ Unplanned Addition | Unrelated dispatch history from another feature branch. |
| `docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/PF-00_report.md` | Unplanned | ➕ Unplanned Addition | Unrelated dispatch history from another feature branch. |
| `docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/R-01_report.md` | Unplanned | ➕ Unplanned Addition | Unrelated dispatch history from another feature branch. |
| `docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/R-02_report.md` | Unplanned | ➕ Unplanned Addition | Unrelated dispatch history from another feature branch. |
| `docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/R-03_report.md` | Unplanned | ➕ Unplanned Addition | Unrelated dispatch history from another feature branch. |
| `docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/R-04_report.md` | Unplanned | ➕ Unplanned Addition | Unrelated dispatch history from another feature branch. |
| `docs/branch/feat-dispatcher-hub-run-integration-fixes/dispatch_plan.md` | Unplanned | ➕ Unplanned Addition | Unrelated dispatch plan from another feature branch. |
| `docs/branch/feat-dispatcher-supervisor-design/v1.0/dev_history/BATCH-5-GATE_report.md` | Unplanned | ➕ Unplanned Addition | Unrelated dispatch history from another feature branch. |
| `docs/branch/feat-dispatcher-supervisor-design/v1.0/dev_history/N-01_report.md` | Unplanned | ➕ Unplanned Addition | Unrelated dispatch history from another feature branch. |
| `docs/branch/feat-dispatcher-supervisor-design/v1.0/dev_history/N-02_report.md` | Unplanned | ➕ Unplanned Addition | Unrelated dispatch history from another feature branch. |
| `docs/branch/feat-dispatcher-supervisor-design/v1.0/dev_history/R-01_report.md` | Unplanned | ➕ Unplanned Addition | Unrelated dispatch history from another feature branch. |
| `docs/branch/feat-dispatcher-supervisor-design/v1.0/dev_history/R-02_report.md` | Unplanned | ➕ Unplanned Addition | Unrelated dispatch history from another feature branch. |
| `docs/branch/feat-dispatcher-supervisor-design/v1.0/dev_history/R-03_report.md` | Unplanned | ➕ Unplanned Addition | Unrelated dispatch history from another feature branch. |
| `docs/branch/feat-dispatcher-supervisor-design/v1.0/dev_history/R-04_report.md` | Unplanned | ➕ Unplanned Addition | Unrelated dispatch history from another feature branch. |
| `docs/branch/feat-dispatcher-supervisor-design/v1.0/dev_history/R-05_report.md` | Unplanned | ➕ Unplanned Addition | Unrelated dispatch history from another feature branch. |
| `docs/branch/feat-dispatcher-supervisor-design/v1.0/dev_history/R-06_report.md` | Unplanned | ➕ Unplanned Addition | Unrelated dispatch history from another feature branch. |
| `docs/branch/feat-dispatcher-supervisor-design/v1.0/dispatch_plan.md` | Unplanned | ➕ Unplanned Addition | Unrelated dispatch plan from another feature branch. |
| `package.json` | N-01 | ✅ Aligned | Registers the `meridian` bin as required. |
| `scripts/readiness_check.sh` | Unplanned | ➕ Unplanned Addition | Helpful utility, but not requested by the PRD/TaskSpec. |
| `skills/install/SKILL.md` | N-03 | ✅ Aligned | Self-contained install skill with prerequisites, install flow, env config, and verification. |
| `src/agents/codex.test.ts` | Unplanned | ➕ Unplanned Addition | Adds reasoning-effort behavior not called for by this PRD. |
| `src/agents/codex.ts` | Unplanned | ➕ Unplanned Addition | Adds reasoning-effort CLI wiring beyond the requested provider/model contract. |
| `src/bin/hub-connection.ts` | N-01 | ✅ Aligned | Adds public-service discovery and reachability checks. |
| `src/bin/meridian-cli.ts` | N-01 / N-02 / R-02 | ⚠️ Scope Drift | Core CLI is present and tested, but non-health commands still route through socket calls only even when HTTP reachability is selected; extra `--effort` support is outside PRD. |
| `src/hub/instance-manager.test.ts` | N-02 / R-02 | ⚠️ Scope Drift | Covers planned model pass-through plus unplanned reasoning-effort behavior. |
| `src/hub/instance-manager.ts` | N-02 / R-02 | ⚠️ Scope Drift | Planned model pass-through is present, but the file also introduces reasoning-effort behavior outside the PRD. |
| `src/hub/result-sender.test.ts` | Unplanned | ➕ Unplanned Addition | GUI-link query-name change is unrelated to the CLI integration scope. |
| `src/hub/router.test.ts` | N-02 / R-02 | ⚠️ Scope Drift | Contains the planned spawn-forwarding assertion, but most added coverage is for unrelated terminal/run-result behavior. |
| `src/hub/router.ts` | N-02 / R-02 | ⚠️ Scope Drift | Planned spawn forwarding is present, but the file also carries substantial unrelated terminal/run-state logic. |
| `src/hub/server.ts` | Unplanned | ➕ Unplanned Addition | Queue concurrency and `reply` intent changes are outside the PRD. |
| `src/interface/index.ts` | Unplanned | ➕ Unplanned Addition | Telegram restart controls for meridian-roles are outside scope. |
| `src/interface/slash-handler.ts` | Unplanned | ➕ Unplanned Addition | Telegram restart help-text change is outside scope. |
| `src/log-retention.test.ts` | Unplanned | ➕ Unplanned Addition | Log-category work is unrelated to CLI integration. |
| `src/log-retention.ts` | Unplanned | ➕ Unplanned Addition | Log-category work is unrelated to CLI integration. |
| `src/shared/telegram-controls.ts` | Unplanned | ➕ Unplanned Addition | GUI-link query-name change is unrelated to CLI integration. |
| `src/types.test.ts` | R-01 / R-02 | ⚠️ Scope Drift | Adds model/effort/run_state coverage, but does not cover the required auto-approve default regression. |
| `src/types.ts` | R-01 / R-02 | ❌ Missing | Adds model/effort/run_state fields, but `payload.auto_approve` remains optional, so non-web/non-CLI callers still default to false instead of true. |
| `src/web/public-app.test.ts` | Unplanned | ➕ Unplanned Addition | Query-token/session-storage behavior is outside the PRD. |
| `src/web/public-layout.test.ts` | R-01 / N-03 | ⚠️ Scope Drift | Includes some hub-layout coverage, but most new assertions are for unrelated terminal/history/log UI work and it misses the required auto-approve default check. |
| `src/web/public/app.js` | Unplanned | ➕ Unplanned Addition | Query-token persistence change is outside the CLI integration scope. |
| `src/web/public/index.html` | R-01 | ❌ Missing | The required first-visit default is still wrong (`localStorage.getItem(...) === "true"` at load time), and the file also bundles unrelated roles/log UI changes. |
| `src/web/public/terminal.html` | Unplanned | ➕ Unplanned Addition | Structured run bubble/history replay changes are unrelated to CLI integration. |
| `src/web/server.test.ts` | N-02 / R-01 / R-02 | ✅ Aligned | Adds good coverage for spawn provider/model/default auto-approve, health, and CLI command behavior. |
| `src/web/server.ts` | R-01 / N-02 / R-02 | ✅ Aligned | Provider alias, model/effort pass-through, health endpoint, and API default auto-approve are implemented as specified. |
| `user_scripts/rebuild_restart.sh` | Unplanned | ➕ Unplanned Addition | Automatically rebuilding meridian-roles is outside the PRD. |
| `user_scripts/restart_meridian_roles.sh` | Unplanned | ➕ Unplanned Addition | New cross-repo restart helper is outside the PRD. |

## Missing Required Artifacts
| File | Worker | Verdict | Notes |
|------|--------|---------|-------|
| `docs/branch/feat-cli-external-integration/dev_history/v1_round/delta_check_report.md` | DELTA-CHECK | ❌ Missing | Required by the TaskSpec and dispatch command, but the file does not exist. |
| `/Users/yzliu/work/skills/taskspec/SKILL.md` | R-06 | ❌ Missing | `R-06_report.md` says the patch was prepared but never applied because the target file was outside the writable environment. |
| `/Users/yzliu/work/Meridian/Meridian-roles` | R-03 / N-04 / N-05 / N-06 / R-04 / R-05 / N-07 | ⚠️ Scope Drift | The companion repo is on a separate branch (`feat/fix/agent-dispatcher`) and is not reviewable from this Meridian PR diff alone. |

## Scope Drift Summary
Meridian-side verification is healthy: `npm run build`, `npx tsc --noEmit`, and the focused 159-test Node suite all passed. The PR is still not mergeable because `R-01` remains incomplete in `src/web/public/index.html` and `src/types.ts`, the required Delta Check report is missing, the external `taskspec` skill patch was never applied, and the branch carries unrelated dispatcher/terminal/manual changes from other workstreams. Because the feature contract spans Meridian, Meridian-roles, and `/Users/yzliu/work/skills/taskspec`, this repo diff is not a clean end-to-end review surface.

## Final Verdict
MERGE BLOCKED — incomplete auto-approve defaults, missing Delta Check artifact, unapplied external skill update, and unrelated branch drift.
