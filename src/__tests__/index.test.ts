import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasPmResolverHandledCurrentWorkerIssue,
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
        error: null
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
