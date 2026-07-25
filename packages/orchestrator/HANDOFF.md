# Handoff — Direction C delivered; storm investigation reset

Date: 2026-05-20
Branch: `main` (changes uncommitted at the time of writing)
Author session: this conversation

---

## 1. What shipped

### Feature: evidence-based auto-exit from `blocked`

Reconciler now promotes a `blocked` worker to `completed` automatically when both of these hold:

1. The configured base branch (default `main`) has a commit in the last 7 days whose subject starts with `[<WORKER_ID>]`.
2. A file at `<plan_dir>/reports/<WORKER_ID>.md` exists with `mtime > worker.last_seen_at` (i.e. the report was written after the worker was last touched).

The promotion goes through the existing `LifecycleStore.setWorkerStatus(workerId, "completed", "auto_force_complete_evidence", { clearHubResult: true })` — same transition path operators use for Force Complete, plus the stale `hub_result` block-signal is cleared. Emits log line `event: lifecycle_auto_force_complete` for observability.

### Files

New:
- `src/roles/agent-dispatcher/commit-scanner.ts` — `git log <baseBranch> --since=<7d>` wrapper, strict `[WORKER_ID]` prefix matching (`W-1` does not absorb `[W-10]`), refuses dash-prefixed branch input, mockable `execFile` seam.
- `src/roles/agent-dispatcher/auto-force-complete-reconciler.ts` — the sweep.
- `src/roles/agent-dispatcher/__tests__/commit-scanner.test.ts` (14 tests).
- `src/roles/agent-dispatcher/__tests__/auto-force-complete-reconciler.test.ts` (8 tests).

Modified:
- `src/roles/agent-dispatcher/watchdog.ts` — wired sweep into `runSweep` between `cleanupTerminalWorkerThreads` and `autoResolve`. Added two opt-in deps: `resolveBaseBranchForDispatchPlan` (default → `"main"`) and `autoForceCompleteEnabled` (default → `true`).
- `src/server/system-monitor/log-counter.ts` — added `lifecycle_auto_force_complete` pattern, 24-hour window.
- `src/server/system-monitor/index.ts` — added indicator `G1` in new group `cure_metrics`, info-style (no thresholds), value = count in last 24h.
- `src/server/__tests__/system-monitor.test.ts` — bumped indicator inventory count from 29 → 30 + asserts G1.

### Test status

- 22/22 new tests pass.
- `npx tsc --noEmit`: clean.
- Full agent-dispatcher suite: 505/506 pass. The one failure is in `validator-orchestrator.test.ts` (`retries validator spawn when Meridian recycles a terminal worker thread id`) and **reproduces on unmodified `main`** — it is a pre-existing flake unrelated to this work.

### What this does NOT do

- Does not fix storms.
- Does not fix `service_restart_*` / `thread not registered` incidents at their source.
- Does not change how PM-resolver is spawned, registered, or killed.
- Does not change hub state persistence.

The feature is downstream cleanup. It removes operator manual-clear work after the orchestration glitched and the worker had already succeeded.

---

## 2. Storm investigation — DO NOT TRUST THE EXISTING LEARNING WITHOUT RE-VERIFICATION

Reading `learnings/storm-recurrence-architectural-root-cause.md` claim-by-claim against the actual code revealed multiple **factual errors** in the learning. The directional advice (C → B → A) was built on those errors. Below is the corrected picture.

### 2.1 Errors in the learning

| Learning claim | Code reality |
|---|---|
| `service_restart_pm_thread_missing` is the smoking-gun error string | **Does not exist** in either meridian-hub or meridian-roles. Grep is empty. The learning paraphrased an error name and treated the paraphrase as evidence. |
| "Sidecar files record dispatch intent + last-known status, but NOT the live hub→codex_NN socket binding" | **False.** Hub persists `socket_path` per instance in `state.json`. See `src/hub/instance-manager.ts:1521` `rehydrateFromState`. |
| Hub restart strands in-flight `codex_NN` children — registrations are lost | **Designed otherwise.** `rehydrateFromState` iterates persisted instances, calls `client.connect(instance.socket_path)` + `client.getStatus()` to re-probe, and re-registers any that respond. (`src/hub/instance-manager.ts:585-633`, `:1521-1580`). |
| "Hub die → recovery dies because they share substrate" | **Hub shutdown does not kill children.** `HubServer.stop()` (`src/hub/server.ts:416-444`) closes its own listening socket and stops internal tickers; it does NOT iterate `instanceManager.children` to kill them. Child processes survive a graceful hub stop. |

### 2.2 Code paths actually verified

These claims are verifiable from the current code and are correct:

- PM-resolver is implemented as a hub-spawned, hub-registered agent. Triggered via `pm-resolve` CLI tool → roles HTTP service → `startPmResolver` → `meridianApi.spawn` + `meridianApi.run` against hub HTTP `/api/spawn`. (`src/roles/agent-dispatcher/pm-resolver.ts`)
- PM-resolver defaults to **`bridge` mode** (not `stateless_call`) — see `src/types.ts:444`. It is meant to survive hub restart via rehydration.
- Worker `LifecycleStatusSchema` does **not** include `manual_intervention_required`. That status is a *response code* returned by the `continue-dispatcher` handler (`src/server/role-handlers.ts:1047, 2403, 2581, 2804`); the worker's persisted lifecycle status during a "manual intervention required" condition is `blocked` (or `failed` after validator max-cycles). This is why direction C scans for `blocked`, not for a non-existent `manual_intervention_required` worker status.
- "`thread_id=X is not registered`" errors come from various ops at `src/hub/instance-manager.ts:282, 334, 431, 468, 501, 643, 692, 1585`. They are thrown when an op runs against a thread the registry no longer holds — which can be because rehydration pruned it (probe failed), or because something else removed it. The learning conflated this with a fictional `service_restart_pm_thread_missing` string.

### 2.3 The product invariant

Per direct user statement during this session:

> meridian-hub 要管理所有的 agent，不允许任何不通过 meridian-hub 自己去调用 agent 的行为存在

Hub is the universal control plane. No service may spawn an agent outside hub. This **invalidates** the learning's direction `A` (out-of-band recovery): not just engineering-wise, but as a product policy violation. Future architectural proposals must respect this invariant.

### 2.4 What this means for diagnosis

The learning's three "pathologies" reduce to one open question:

> **PM-resolver is designed to survive hub restart via socket rehydration. Why does it actually fail in incidents?**

Possible mechanisms (none yet verified — these are hypotheses, not findings):

- **(a) Race:** PM-resolver spawned but `state.json` not yet flushed when hub goes down — next-generation hub has no record of the instance.
- **(b) Probe failure:** Persistence ok, but on rehydrate `client.connect` / `getStatus` against the agentapi socket fails — instance pruned, "thread not registered" thereafter. Need to know **why** the probe fails (socket dead? process gone? agentapi unhealthy?).
- **(c) Some other code path:** Not actually a rehydration failure at all — a different bug we haven't located.

**Resolving this requires a real incident log**, not more architecture talk. Specifically, the next storm event should be debugged by capturing:

- `hub.log` lines around the restart, especially `Skipping persisted agent instance because readiness probe failed` and `Hub router state initialized`.
- All log lines mentioning the affected PM-resolver `thread_id`.
- `state.json` contents both before the hub shutdown and after rehydrate.
- Whether pm2 (or whatever runs hub) sent SIGTERM or SIGKILL.

### 2.5 Recommended next steps for the next contributor

1. **Do not write code based on `storm-recurrence-architectural-root-cause.md` as-is.** That learning needs a correction pass against the findings in §2.1 before it can be cited again.
2. **Add a learning correction** (or supersede entry) noting the verified-vs-claimed reality of hub rehydration.
3. **Wait for a real incident's log**, then trace the actual failure mode from log → state.json → code path. With concrete evidence, the fix is likely small (a flush ordering, a probe retry, an agentapi socket cleanup) rather than the multi-week restructuring the original learning implied.
4. **Treat any storm-fix PR opened in the meantime as surgical.** The original learning's "three-question check" still applies to surgical PRs (path-count, topology-unchanged, link the learning) — but the learning itself needs updating first.

---

## 3. Open items left by this session

- [ ] Commit the C changes and open a PR (not done yet — author paused to write this handoff first).
- [ ] Update `learnings/storm-recurrence-architectural-root-cause.md` with the corrections in §2.1, OR add a sibling learning that supersedes it.
- [ ] Wire `resolveBaseBranchForDispatchPlan` to the dispatcher's `validatorConfig.base_branch` so non-`main` base branches work without per-call overrides. (Currently defaults to `"main"`.)
- [ ] Investigate and fix the pre-existing flake in `validator-orchestrator.test.ts` — `retries validator spawn when Meridian recycles a terminal worker thread id`. Out of scope for this PR but worth a follow-up.

---

## 4. Files-quick-reference

```
src/roles/agent-dispatcher/
├── commit-scanner.ts                          (new, 95 lines)
├── auto-force-complete-reconciler.ts          (new, 130 lines)
├── watchdog.ts                                (modified — sweep wired in)
└── __tests__/
    ├── commit-scanner.test.ts                 (new, 14 tests)
    └── auto-force-complete-reconciler.test.ts (new, 8 tests)

src/server/system-monitor/
├── log-counter.ts                             (modified — pattern added)
└── index.ts                                   (modified — G1 indicator)

src/server/__tests__/
└── system-monitor.test.ts                     (modified — count 29 → 30, G1 assert)
```

---

## 5. PR framing (when shipping)

Suggested title:
```
feat(reconciler): evidence-based auto-exit for blocked workers (direction C)
```

Body must:
- Cite `learnings/storm-recurrence-architectural-root-cause.md` and frame as direction-C delivery — but note in the PR body that the learning's broader storm diagnosis was found to be partly incorrect during this implementation (see HANDOFF.md §2).
- State explicitly that this PR does NOT fix storms; it removes the manual-clear work after an orchestration glitch leaves a successful worker in `blocked`.
- Note the surgical-PR three-question check from the learning does not apply because this is direction-C delivery (architectural, not surgical).
