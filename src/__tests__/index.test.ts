import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildWatchdogPmResolverIssueKey,
  hasPmResolverHandledCurrentWorkerIssue,
  resolveRetryExhaustedWorkerNeedingPm,
  tryContinueDispatchWorker,
  type WatchdogContinueDispatcher
} from "../index";
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

function buildPmResolverGuardState(options: {
  workerStartedAt: string;
  pmStartedAt: string;
  pmStatus: "running" | "completed" | "failed";
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
        retry_count: 0
      }
    },
    pm_resolvers: [
      {
        thread_id: "codex_45",
        status: options.pmStatus,
        started_at: options.pmStartedAt,
        last_seen_at: "2026-05-02T18:00:49.572Z",
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
        result: null,
        error: null,
        transport_error: null
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
