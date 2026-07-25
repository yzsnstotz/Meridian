import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../roles/agent-dispatcher/pm-resolver", () => ({
  startPmResolver: vi.fn()
}));

import {
  buildWatchdogPmResolverIssueKey,
  hasPmResolverHandledCurrentWorkerIssue,
  maybeStartPmResolverForWatchdogRecovery,
  resolveRetryExhaustedWorkerNeedingPm,
  tryContinueDispatchWorker,
  type WatchdogContinueDispatcher
} from "../index";
import { startPmResolver } from "../roles/agent-dispatcher/pm-resolver";
import { StateStore } from "../state-store";
import type { AppState, DispatchThreadStateV2 } from "../types";

describe("watchdog direct dispatcher recovery", () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => fs.rm(directory, { recursive: true, force: true })));
    tempDirs = [];
    vi.restoreAllMocks();
  });

  it("routes direct worker recovery through dispatcher continuation so validation can intercept first", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-watchdog-recovery-"));
    tempDirs.push(tempDir);

    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const stateStore = new StateStore(path.join(tempDir, "state.json"));
    const state: AppState = {
      roles: [
        {
          threadId: "agent-dispatcher-validation-recovery",
          roleType: "agent-dispatcher",
          status: "active",
          config: {
            dispatch_plan_path: dispatchPlanPath,
            command_file_path: path.join(tempDir, "dispatch_command.md"),
            user_reply_channels: [
              {
                channel: "telegram",
                chat_id: "telegram:ops"
              }
            ],
            agent_type: "codex",
            mode: "bridge",
            kill_policy: "always",
            validator: {
              enabled: true,
              agent_type: "codex",
              mode: "bridge",
              pass_threshold: 0.85,
              max_fix_cycles: 3,
              base_branch: "main"
            }
          }
        }
      ],
      promptStore: {}
    };
    await stateStore.save(state);

    const continueDispatcher = vi.fn<WatchdogContinueDispatcher>().mockResolvedValue({
      ok: true,
      status: "validation_in_progress",
      message: "validation started for N-04",
      worker: "N-04",
      validation_outcome: "started"
    });

    await expect(
      tryContinueDispatchWorker(
        stateStore,
        dispatchPlanPath,
        "N-05",
        continueDispatcher,
        silentLog()
      )
    ).resolves.toEqual({
      status: "validation_in_progress",
      workerId: "N-04",
      message: "validation started for N-04"
    });

    expect(continueDispatcher).toHaveBeenCalledWith("agent-dispatcher-validation-recovery", "N-05");
  });

  it("treats parallel continuation as active watchdog progress", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-watchdog-parallel-"));
    tempDirs.push(tempDir);

    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const stateStore = new StateStore(path.join(tempDir, "state.json"));
    await stateStore.save({
      roles: [
        {
          threadId: "agent-dispatcher-parallel-watchdog",
          roleType: "agent-dispatcher",
          status: "needs_reactivation",
          config: {
            dispatch_plan_path: dispatchPlanPath,
            command_file_path: path.join(tempDir, "dispatch_command.md"),
            user_reply_channels: [
              {
                channel: "telegram",
                chat_id: "telegram:ops"
              }
            ],
            agent_type: "codex",
            mode: "bridge",
            kill_policy: "always",
            parallel_dispatch: {
              enabled: true,
              max_concurrency: 2
            }
          }
        }
      ],
      promptStore: {}
    });

    const continueDispatcher = vi.fn<WatchdogContinueDispatcher>().mockResolvedValue({
      ok: true,
      status: "continued_parallel",
      message: "continued parallel: R-01, R-02",
      started_workers: ["R-01", "R-02"]
    });

    await expect(
      tryContinueDispatchWorker(
        stateStore,
        dispatchPlanPath,
        "R-01",
        continueDispatcher,
        silentLog()
      )
    ).resolves.toEqual({
      status: "continued_parallel",
      workerId: "R-01",
      message: "continued parallel: R-01, R-02"
    });

    await expect(stateStore.load()).resolves.toMatchObject({
      roles: [
        {
          threadId: "agent-dispatcher-parallel-watchdog",
          status: "active"
        }
      ]
    });
  });
});

describe("watchdog PM resolver repeat guard", () => {
  it("selects a retry-exhausted abandoned worker for PM resolution even when later work can continue", () => {
    const state: Pick<DispatchThreadStateV2, "workers" | "pm_resolvers"> = {
      workers: {
        "N-01": {
          thread_id: "codex_37",
          trace_id: null,
          started_at: "2026-05-05T06:10:43.917Z",
          last_seen_at: "2026-05-05T06:11:48.773Z",
          status: "abandoned",
          expected_outputs: ["/tmp/reports/N-01.md"],
          hub_result: null,
          command_preamble: null,
          retry_count: 2
        },
        "N-02": {
          thread_id: "codex_41",
          trace_id: null,
          started_at: "2026-05-05T06:20:43.920Z",
          last_seen_at: "2026-05-05T06:22:42.766Z",
          status: "running",
          expected_outputs: ["/tmp/reports/N-02.md"],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      pm_resolvers: []
    };

    expect(resolveRetryExhaustedWorkerNeedingPm(state)).toBe("N-01");
  });

  it("treats a non-failed PM resolver after the current worker start as handled", () => {
    const state = buildPmResolverGuardState({
      workerStartedAt: "2026-05-02T17:52:24.552Z",
      pmStartedAt: "2026-05-02T17:58:29.599Z",
      pmStatus: "completed"
    });

    expect(hasPmResolverHandledCurrentWorkerIssue(state, "N-07")).toBe(true);
  });

  it("allows a new PM resolver after the worker is retried", () => {
    const state = buildPmResolverGuardState({
      workerStartedAt: "2026-05-02T19:00:00.000Z",
      pmStartedAt: "2026-05-02T17:58:29.599Z",
      pmStatus: "completed"
    });

    expect(hasPmResolverHandledCurrentWorkerIssue(state, "N-07")).toBe(false);
  });

  it("does not count failed PM resolver attempts as handled", () => {
    const state = buildPmResolverGuardState({
      workerStartedAt: "2026-05-02T17:52:24.552Z",
      pmStartedAt: "2026-05-02T17:58:29.599Z",
      pmStatus: "failed"
    });

    expect(hasPmResolverHandledCurrentWorkerIssue(state, "N-07")).toBe(false);
  });

  // Regression: agent-dispatcher-67f6a3fc W-15 on 2026-05-15 piled up 7 PM
  // resolvers within ~30 minutes against the same unresolvable Cloudflare
  // credential blocker because each `resume-worker --action retry --force true`
  // advanced worker.started_at past the prior escalation entry, reopening the
  // started_at-based gate. The escalation verdict must close the gate until a
  // human acknowledges via /human-resolve, regardless of how many times the
  // worker has been retried since.
  it("treats an escalate_human PM resolver as handled even when the worker has been retried since", () => {
    const state = buildPmResolverGuardState({
      // Worker has been retried well AFTER the PM ran — pre-patch this would
      // have reopened the gate.
      workerStartedAt: "2026-05-15T11:00:00.000Z",
      pmStartedAt: "2026-05-15T10:19:00.000Z",
      pmLastSeenAt: "2026-05-15T10:19:30.000Z",
      pmStatus: "completed",
      markerOutcome: "escalated",
      markerPmAction: "escalate_human"
    });

    expect(hasPmResolverHandledCurrentWorkerIssue(state, "N-07")).toBe(true);
  });

  it("releases the escalation freeze once /human-resolve stamps human_resolution after the PM entry", () => {
    const state = buildPmResolverGuardState({
      // Worker retried after the human acknowledged.
      workerStartedAt: "2026-05-15T11:00:00.000Z",
      pmStartedAt: "2026-05-15T10:19:00.000Z",
      pmLastSeenAt: "2026-05-15T10:19:30.000Z",
      pmStatus: "completed",
      markerOutcome: "escalated",
      markerPmAction: "escalate_human",
      humanResolvedAt: "2026-05-15T10:45:00.000Z"
    });

    // Human acknowledged AND worker.started_at advanced past pmStartedAt: gate
    // falls back to the normal started_at timing semantics, which says this
    // run is unhandled and a fresh PM may spawn.
    expect(hasPmResolverHandledCurrentWorkerIssue(state, "N-07")).toBe(false);
  });

  it("keeps the escalation freeze when human_resolution predates the escalation entry", () => {
    const state = buildPmResolverGuardState({
      workerStartedAt: "2026-05-15T11:00:00.000Z",
      pmStartedAt: "2026-05-15T10:19:00.000Z",
      pmLastSeenAt: "2026-05-15T10:19:30.000Z",
      pmStatus: "completed",
      markerOutcome: "escalated",
      markerPmAction: "escalate_human",
      // Stale acknowledgement from a prior escalation cycle — must not
      // release the current freeze.
      humanResolvedAt: "2026-05-15T09:00:00.000Z"
    });

    expect(hasPmResolverHandledCurrentWorkerIssue(state, "N-07")).toBe(true);
  });

  // Regression: agent-dispatcher-67f6a3fc E-03 on 2026-05-15 piled up three
  // PM resolvers within 12 minutes (codex_66 → 67 → 68) against the same
  // unresolvable Cloudflare credential blocker. `recordPmResolverResult`
  // writes `status: "failed"` for escalation markers so the reconciler can
  // later promote on worker recovery, but the gate's `status === "failed"`
  // short-circuit was excluding those entries BEFORE the
  // `marker_pm_action === "escalate_human"` freeze ran, so each watchdog
  // sweep saw no handled PM and spawned a fresh one. The marker is
  // authoritative over envelope status: the freeze must apply even when
  // status is "failed".
  it("treats an escalate_human PM resolver as handled even when the recording path wrote status=failed", () => {
    const state = buildPmResolverGuardState({
      workerStartedAt: "2026-05-15T12:01:23.494Z",
      pmStartedAt: "2026-05-15T12:25:25.091Z",
      pmLastSeenAt: "2026-05-15T12:29:43.844Z",
      // Real recording path for an escalate_human marker against a "blocked"
      // worker: reconcilePmStatusAgainstWorkerState returns "failed" because
      // "blocked" is not in PM_RESOLVED_TARGET_STATUSES.
      pmStatus: "failed",
      markerOutcome: "escalated",
      markerPmAction: "escalate_human"
    });

    expect(hasPmResolverHandledCurrentWorkerIssue(state, "N-07")).toBe(true);
  });

  // Regression (backward-compat): a meridian-roles service restart that
  // lands after a pre-#219 binary persisted PM entries leaves
  // `marker_pm_action: null` on disk even though the PM's stored reply
  // content contains a valid `<<<MERIDIAN-STATUS>>> pm_action: escalate_human`
  // marker. Without a content-fallback path, the new gate logic would not
  // see those entries as handled and the dispatcher would respawn another
  // PM on the next watchdog sweep — the exact loop observed on E-03.
  it("recovers escalate_human from stored reply content when marker_pm_action is null (pre-#219 entry)", () => {
    const state = buildPmResolverGuardState({
      workerStartedAt: "2026-05-15T12:01:23.494Z",
      pmStartedAt: "2026-05-15T12:25:25.091Z",
      pmLastSeenAt: "2026-05-15T12:29:43.844Z",
      pmStatus: "failed",
      markerOutcome: null,
      markerPmAction: null,
      resultContent: [
        "PM verified the blocker is external Cloudflare credentials.",
        "",
        "<<<MERIDIAN-STATUS>>>",
        "worker_id: N-07",
        "role: pm-resolver",
        "outcome: escalated",
        "pm_action: escalate_human",
        "notes: blocked on credential rotation",
        "<<<END>>>"
      ].join("\n")
    });

    expect(hasPmResolverHandledCurrentWorkerIssue(state, "N-07")).toBe(true);
  });

  // Defence in depth for the same backward-compat path: a marker emitted
  // for a different worker (thread-id-collision bleed shape) MUST NOT
  // close the gate. The fallback parser enforces role + worker_id match,
  // mirroring `recordPmResolverResult`.
  it("ignores stored content marker when its worker_id does not match the entry's target", () => {
    const state = buildPmResolverGuardState({
      workerStartedAt: "2026-05-15T12:01:23.494Z",
      pmStartedAt: "2026-05-15T12:25:25.091Z",
      pmLastSeenAt: "2026-05-15T12:29:43.844Z",
      pmStatus: "failed",
      markerOutcome: null,
      markerPmAction: null,
      resultContent: [
        "<<<MERIDIAN-STATUS>>>",
        "worker_id: OTHER-99",
        "role: pm-resolver",
        "outcome: escalated",
        "pm_action: escalate_human",
        "<<<END>>>"
      ].join("\n")
    });

    expect(hasPmResolverHandledCurrentWorkerIssue(state, "N-07")).toBe(false);
  });
});

describe("buildWatchdogPmResolverIssueKey", () => {
  // Regression: a successful PM that recovered a worker to `pending` used to
  // leave the dedupe key cached forever. When the worker re-ran and re-emitted
  // needs_pm, the cached key short-circuited the watchdog before the
  // time-aware lifecycle gate ran. Folding the current worker's `started_at`
  // into the key makes a fresh run produce a fresh key.
  it("produces a fresh key for a relaunched worker (different started_at)", () => {
    const first = buildWatchdogPmResolverIssueKey(
      "agent-dispatcher-8eb13a31",
      "manual_intervention_required",
      "BATCH-3-GATE",
      "2026-05-13T20:00:00.000Z"
    );
    const second = buildWatchdogPmResolverIssueKey(
      "agent-dispatcher-8eb13a31",
      "manual_intervention_required",
      "BATCH-3-GATE",
      "2026-05-14T03:02:26.742Z"
    );

    expect(first).not.toBe(second);
  });

  it("dedupes within the same worker run (same started_at)", () => {
    const startedAt = "2026-05-14T03:02:26.742Z";
    const first = buildWatchdogPmResolverIssueKey(
      "agent-dispatcher-8eb13a31",
      "manual_intervention_required",
      "BATCH-3-GATE",
      startedAt
    );
    const second = buildWatchdogPmResolverIssueKey(
      "agent-dispatcher-8eb13a31",
      "manual_intervention_required",
      "BATCH-3-GATE",
      startedAt
    );

    expect(first).toBe(second);
  });

  it("treats missing worker / started_at as stable keys (legacy behavior)", () => {
    const a = buildWatchdogPmResolverIssueKey("agent-dispatcher-x", "manual_intervention_required", null, null);
    const b = buildWatchdogPmResolverIssueKey("agent-dispatcher-x", "manual_intervention_required", null, undefined);

    expect(a).toBe(b);
  });
});

describe("maybeStartPmResolverForWatchdogRecovery cache eviction", () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => fs.rm(directory, { recursive: true, force: true })));
    tempDirs = [];
    vi.mocked(startPmResolver).mockReset();
  });

  // Regression: `reconcilePmResolverLiveness` (PR #214) evicts a PM whose hub
  // thread has gone missing, flipping its lifecycle entry to `failed`. The
  // process-lifetime `seenIssueKeys` cache used to outlive that eviction, so
  // every later watchdog sweep short-circuited at "PM resolver already
  // requested for this issue" and never spawned a replacement PM. Observed on
  // agent-dispatcher-67f6a3fc BATCH-5-GATE where PM codex_13's spawn hit a
  // hub-run transport timeout, the watchdog evicted the missing thread, and
  // the dispatcher then wedged indefinitely. The fix drops the cached key when
  // the lifecycle gate says the worker issue is no longer handled.
  it("drops a stale seen-issue cache entry when the prior PM resolver was evicted as failed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-watchdog-pm-cache-"));
    tempDirs.push(tempDir);

    const dispatcherThreadId = "agent-dispatcher-67f6a3fc-test";
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const dispatchThreadsPath = path.join(tempDir, "dispatch_threads.json");
    const workerId = "BATCH-5-GATE";
    const workerStartedAt = "2026-05-15T03:00:00.000Z";

    const lifecycle: DispatchThreadStateV2 = {
      version: 2,
      dispatcher: {
        thread_id: dispatcherThreadId,
        started_at: workerStartedAt,
        status: "running"
      },
      workers: {
        [workerId]: {
          thread_id: "codex_11",
          trace_id: null,
          started_at: workerStartedAt,
          last_seen_at: "2026-05-15T03:41:30.662Z",
          status: "blocked",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      pm_resolvers: [
        {
          thread_id: "codex_13",
          status: "failed",
          started_at: "2026-05-15T03:42:59.927Z",
          last_seen_at: "2026-05-15T03:49:59.964Z",
          agent_type: "codex",
          model_id: "gpt-5.5 xhigh",
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: workerId,
            message: "manual intervention required: BATCH-5-GATE reported a blocking outcome",
            error: null,
            source: "watchdog"
          },
          result: null,
          error: "watchdog_pm_thread_missing: hub_status=missing",
          transport_error: null,
          marker_outcome: null,
          marker_pm_action: null
        }
      ],
      last_reconciled_at: "2026-05-15T03:49:59.964Z"
    };
    await fs.writeFile(dispatchThreadsPath, JSON.stringify(lifecycle, null, 2), "utf8");

    const stateStore = new StateStore(path.join(tempDir, "state.json"));
    const state: AppState = {
      roles: [
        {
          threadId: dispatcherThreadId,
          roleType: "agent-dispatcher",
          status: "active",
          config: {
            dispatch_plan_path: dispatchPlanPath,
            command_file_path: path.join(tempDir, "dispatch_command.md"),
            user_reply_channels: [
              {
                channel: "telegram",
                chat_id: "telegram:ops"
              }
            ],
            agent_type: "codex",
            mode: "bridge",
            kill_policy: "always"
          }
        }
      ],
      promptStore: {}
    };
    await stateStore.save(state);

    const issueKey = buildWatchdogPmResolverIssueKey(
      dispatcherThreadId,
      "manual_intervention_required",
      workerId,
      workerStartedAt
    );
    const seenIssueKeys = new Set<string>([issueKey]);

    vi.mocked(startPmResolver).mockResolvedValue({
      ok: true,
      status: "pm_resolver_started",
      thread_id: "codex_99",
      message: "PM resolver started for BATCH-5-GATE"
    });

    await maybeStartPmResolverForWatchdogRecovery(
      stateStore,
      dispatcherThreadId,
      {
        status: "manual_intervention_required",
        workerId,
        message: "manual intervention required: BATCH-5-GATE reported a blocking outcome"
      },
      seenIssueKeys,
      silentLog()
    );

    expect(vi.mocked(startPmResolver)).toHaveBeenCalledTimes(1);
    expect(seenIssueKeys.has(issueKey)).toBe(true);
  });

  it("still short-circuits when the prior PM resolver is still running", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-watchdog-pm-cache-"));
    tempDirs.push(tempDir);

    const dispatcherThreadId = "agent-dispatcher-cache-still-active";
    const dispatchPlanPath = path.join(tempDir, "dispatch_plan.md");
    const dispatchThreadsPath = path.join(tempDir, "dispatch_threads.json");
    const workerId = "BATCH-5-GATE";
    const workerStartedAt = "2026-05-15T03:00:00.000Z";

    const lifecycle: DispatchThreadStateV2 = {
      version: 2,
      dispatcher: {
        thread_id: dispatcherThreadId,
        started_at: workerStartedAt,
        status: "running"
      },
      workers: {
        [workerId]: {
          thread_id: "codex_11",
          trace_id: null,
          started_at: workerStartedAt,
          last_seen_at: "2026-05-15T03:41:30.662Z",
          status: "blocked",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      pm_resolvers: [
        {
          thread_id: "codex_13",
          status: "running",
          started_at: "2026-05-15T03:42:59.927Z",
          last_seen_at: "2026-05-15T03:45:00.000Z",
          agent_type: "codex",
          model_id: "gpt-5.5 xhigh",
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: workerId,
            message: "manual intervention required: BATCH-5-GATE reported a blocking outcome",
            error: null,
            source: "watchdog"
          },
          result: null,
          error: null,
          transport_error: null,
          marker_outcome: null,
          marker_pm_action: null
        }
      ],
      last_reconciled_at: "2026-05-15T03:45:00.000Z"
    };
    await fs.writeFile(dispatchThreadsPath, JSON.stringify(lifecycle, null, 2), "utf8");

    const stateStore = new StateStore(path.join(tempDir, "state.json"));
    await stateStore.save({
      roles: [
        {
          threadId: dispatcherThreadId,
          roleType: "agent-dispatcher",
          status: "active",
          config: {
            dispatch_plan_path: dispatchPlanPath,
            command_file_path: path.join(tempDir, "dispatch_command.md"),
            user_reply_channels: [{ channel: "telegram", chat_id: "telegram:ops" }],
            agent_type: "codex",
            mode: "bridge",
            kill_policy: "always"
          }
        }
      ],
      promptStore: {}
    });

    const issueKey = buildWatchdogPmResolverIssueKey(
      dispatcherThreadId,
      "manual_intervention_required",
      workerId,
      workerStartedAt
    );
    const seenIssueKeys = new Set<string>([issueKey]);

    await maybeStartPmResolverForWatchdogRecovery(
      stateStore,
      dispatcherThreadId,
      {
        status: "manual_intervention_required",
        workerId,
        message: "manual intervention required: BATCH-5-GATE reported a blocking outcome"
      },
      seenIssueKeys,
      silentLog()
    );

    expect(vi.mocked(startPmResolver)).not.toHaveBeenCalled();
    expect(seenIssueKeys.has(issueKey)).toBe(true);
  });
});

function buildPmResolverGuardState(options: {
  workerStartedAt: string;
  pmStartedAt: string;
  pmStatus: "running" | "completed" | "failed";
  pmLastSeenAt?: string;
  markerOutcome?: "resolved" | "escalated" | null;
  markerPmAction?: "retry" | "skip" | "force_complete" | "wait" | "escalate_human" | null;
  humanResolvedAt?: string | null;
  // Stored reply content for the PM run. Used by the gate's
  // backward-compat fallback that re-parses a `<<<MERIDIAN-STATUS>>>`
  // marker when the persisted `marker_pm_action` field is null (pre-#219
  // binaries did not have that schema field).
  resultContent?: string;
}): Pick<DispatchThreadStateV2, "workers" | "pm_resolvers"> {
  return {
    workers: {
      "N-07": {
        thread_id: "codex_44",
        trace_id: null,
        started_at: options.workerStartedAt,
        last_seen_at: "2026-05-02T18:17:50.512Z",
        status: "blocked",
        expected_outputs: [],
        hub_result: null,
        command_preamble: null,
        retry_count: 0,
        human_resolution: options.humanResolvedAt
          ? { resolved_at: options.humanResolvedAt, note: null }
          : undefined
      }
    },
    pm_resolvers: [
      {
        thread_id: "codex_45",
        status: options.pmStatus,
        started_at: options.pmStartedAt,
        last_seen_at: options.pmLastSeenAt ?? "2026-05-02T18:00:49.572Z",
        agent_type: "codex",
        model_id: null,
        mode: "bridge",
        auto_approve: true,
        issue: {
          status: "manual_intervention_required",
          worker_id: "N-07",
          message: "manual intervention required: N-07 is blocked",
          error: null,
          source: "watchdog"
        },
        result: options.resultContent
          ? {
              status: "success",
              run_state: null,
              content: options.resultContent,
              summary_text: null,
              details_text: null,
              trace_id: null,
              timestamp: options.pmLastSeenAt ?? "2026-05-02T18:00:49.572Z"
            }
          : null,
        error: null,
        transport_error: null,
        marker_outcome: options.markerOutcome ?? null,
        marker_pm_action: options.markerPmAction ?? null
      }
    ]
  };
}

function silentLog(): typeof console {
  return {
    ...console,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}
