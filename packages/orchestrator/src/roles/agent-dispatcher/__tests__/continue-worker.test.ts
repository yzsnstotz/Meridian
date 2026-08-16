import * as fsPromises from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  continueDispatchWorker,
  extractRepoFieldFromWorkerFile,
  resolveWorkerSpawnDir
} from "../continue-worker";
import { LifecycleStore } from "../lifecycle-store";

const tempDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirectories, async (directory) => {
      await fsPromises.rm(directory, { recursive: true, force: true });
    })
  );
  tempDirectories.clear();
});

describe("extractRepoFieldFromWorkerFile", () => {
  it("extracts repo path from standard worker file format", () => {
    const content = [
      "### N-06 — ADS Meridian Integration Client",
      "",
      "- **Repo**: `/Users/work/projects/ADS`",
      "- **Runtime**: Node.js + TypeScript",
    ].join("\n");

    expect(extractRepoFieldFromWorkerFile(content)).toBe("/Users/work/projects/ADS");
  });

  it("extracts repo path without backticks", () => {
    const content = "- **Repo**: /Users/work/meridian\n- **Runtime**: Node.js";

    expect(extractRepoFieldFromWorkerFile(content)).toBe("/Users/work/meridian");
  });

  it("extracts repo path with asterisk bullet and no bold", () => {
    const content = "* Repo: /tmp/my-repo\n* Runtime: Node.js";

    expect(extractRepoFieldFromWorkerFile(content)).toBe("/tmp/my-repo");
  });

  it("prefers an inline absolute repo path over the display alias", () => {
    const content = "- **Repo**: `github-ai-automation-scan` (`/Users/work/github-ai-automation-scan`)";

    expect(extractRepoFieldFromWorkerFile(content)).toBe("/Users/work/github-ai-automation-scan");
  });

  it("strips read-only qualifier text from repo aliases", () => {
    const content = "- **Repo**: both (read-only — no code changes, no branch creation)";

    expect(extractRepoFieldFromWorkerFile(content)).toBe("both");
  });

  it("returns null when no Repo field exists", () => {
    const content = "### N-01 — Init\n\n- **Runtime**: Node.js";

    expect(extractRepoFieldFromWorkerFile(content)).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(extractRepoFieldFromWorkerFile("")).toBeNull();
  });
});

describe("resolveWorkerSpawnDir", () => {
  async function createTempPlan(workerFiles: Record<string, string>): Promise<string> {
    const dir = await fsPromises.mkdtemp(path.join(tmpdir(), "spawn-dir-test-"));
    tempDirectories.add(dir);

    const planPath = path.join(dir, "dispatch_plan.md");
    await fsPromises.writeFile(planPath, [
      "# Plan",
      "",
      "## Repo Map",
      "",
      "| Prefix | Repo | Path | Base Branch |",
      "|--------|------|------|-------------|",
      "| `T-*` | `github-ai-automation-scan` | `/Users/work/github-ai-automation-scan` | `main` |",
      "| `M-*` | `Meridian-roles` | `/Users/work/Meridian/Meridian-roles` | `main` |",
      "| `PRE-FLIGHT`, `*-GATE` | both (read-only) | n/a | n/a |",
      ""
    ].join("\n"), "utf8");

    for (const [workerId, content] of Object.entries(workerFiles)) {
      await fsPromises.writeFile(path.join(dir, `${workerId}.md`), content, "utf8");
    }

    return planPath;
  }

  it("returns repo path from worker file when present", async () => {
    const planPath = await createTempPlan({
      "N-06": "- **Repo**: `/Users/work/projects/ADS`\n- **Runtime**: Node.js"
    });

    expect(resolveWorkerSpawnDir(planPath, "N-06")).toBe("/Users/work/projects/ADS");
  });

  it("returns null when worker file does not exist", async () => {
    const planPath = await createTempPlan({});

    expect(resolveWorkerSpawnDir(planPath, "N-99")).toBeNull();
  });

  it("returns null when worker file has no Repo field", async () => {
    const planPath = await createTempPlan({
      "R-01": "### R-01\n\n- **Runtime**: Node.js"
    });

    expect(resolveWorkerSpawnDir(planPath, "R-01")).toBeNull();
  });

  it("resolves different repos for different workers", async () => {
    const planPath = await createTempPlan({
      "N-06": "- **Repo**: `/Users/work/projects/ADS`",
      "R-01": "- **Repo**: `/Users/work/meridian`"
    });

    expect(resolveWorkerSpawnDir(planPath, "N-06")).toBe("/Users/work/projects/ADS");
    expect(resolveWorkerSpawnDir(planPath, "R-01")).toBe("/Users/work/meridian");
  });

  it("resolves repo aliases through the dispatch plan repo map", async () => {
    const planPath = await createTempPlan({
      "T-DB-SCHEMA": "- **Repo**: `github-ai-automation-scan`\n- **Runtime**: Python",
      "M-SCHEDULER-WIRE": "- **Repo**: `Meridian-roles`\n- **Runtime**: TypeScript"
    });

    expect(resolveWorkerSpawnDir(planPath, "T-DB-SCHEMA")).toBe("/Users/work/github-ai-automation-scan");
    expect(resolveWorkerSpawnDir(planPath, "M-SCHEDULER-WIRE")).toBe("/Users/work/Meridian/Meridian-roles");
  });

  it("does not resolve read-only both repo aliases as literal directories", async () => {
    const planPath = await createTempPlan({
      "PRE-FLIGHT": "- **Repo**: both (read-only — no code changes, no branch creation)"
    });

    expect(resolveWorkerSpawnDir(planPath, "PRE-FLIGHT")).toBeNull();
  });
});

describe("continueDispatchWorker", () => {
  async function createTempDispatchPlan(): Promise<{ dir: string; planPath: string; commandPath: string }> {
    const dir = await fsPromises.mkdtemp(path.join(tmpdir(), "continue-worker-test-"));
    tempDirectories.add(dir);
    const planPath = path.join(dir, "dispatch_plan.md");
    const commandPath = path.join(dir, "agent_dispatch_command.md");
    await fsPromises.writeFile(planPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| ⬜ | 1 | N-04 | Findings C | CODEX-HIGH | N-01 | Single module |"
    ].join("\n"), "utf8");
    await fsPromises.writeFile(commandPath, "# command\n", "utf8");
    return { dir, planPath, commandPath };
  }

  it("uses the dispatcher spawn root override before a non-Codex worker Repo target", async () => {
    const { dir, planPath, commandPath } = await createTempDispatchPlan();
    const overrideRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "spawn-root-override-"));
    const targetRepoRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "target-repo-root-"));
    tempDirectories.add(overrideRoot);
    tempDirectories.add(targetRepoRoot);
    await fsPromises.writeFile(
      path.join(dir, "N-04.md"),
      `- **Repo**: \`${targetRepoRoot}\`\n- **Runtime**: TypeScript`,
      "utf8"
    );
    const launchWorker = vi.fn().mockResolvedValue({
      ok: true,
      threadId: "claude-worker-thread"
    });

    await continueDispatchWorker(
      {
        dispatch_plan_path: planPath,
        command_file_path: commandPath,
        mode: "bridge",
        agent_type: "codex",
        kill_policy: "always",
        auto_approve: true,
        dispatch_repo_root: overrideRoot,
        model_map: {
          OPUS: {
            provider: "claude",
            model_id: "claude-opus-4-7"
          }
        }
      },
      [{ status: "⬜", worker: "N-04", model: "OPUS", notes: "Single module" }],
      "N-04",
      launchWorker
    );

    expect(launchWorker).toHaveBeenCalledWith(expect.objectContaining({
      agentType: "claude",
      dispatchRepoRoot: overrideRoot
    }));
  });

  it("uses the worker Repo target when the dispatcher spawn root override is absent", async () => {
    const { dir, planPath, commandPath } = await createTempDispatchPlan();
    const targetRepoRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "target-repo-root-"));
    tempDirectories.add(targetRepoRoot);
    await fsPromises.writeFile(
      path.join(dir, "N-04.md"),
      `- **Repo**: \`${targetRepoRoot}\`\n- **Runtime**: TypeScript`,
      "utf8"
    );
    const launchWorker = vi.fn().mockResolvedValue({
      ok: true,
      threadId: "gemini-worker-thread"
    });

    await continueDispatchWorker(
      {
        dispatch_plan_path: planPath,
        command_file_path: commandPath,
        mode: "bridge",
        agent_type: "codex",
        kill_policy: "always",
        auto_approve: true,
        model_map: {
          GEMINI: {
            provider: "gemini",
            model_id: "gemini-2.5-pro"
          }
        }
      },
      [{ status: "⬜", worker: "N-04", model: "GEMINI", notes: "Single module" }],
      "N-04",
      launchWorker
    );

    expect(launchWorker).toHaveBeenCalledWith(expect.objectContaining({
      agentType: "gemini",
      dispatchRepoRoot: targetRepoRoot
    }));
  });

  it("passes validator max cycles to launchable workers when role validation is enabled", async () => {
    const { dir, planPath, commandPath } = await createTempDispatchPlan();
    const launchWorker = vi.fn().mockResolvedValue({
      ok: true,
      threadId: "worker-thread-n04"
    });

    const result = await continueDispatchWorker(
      {
        dispatch_plan_path: planPath,
        command_file_path: commandPath,
        mode: "bridge",
        agent_type: "codex",
        kill_policy: "always",
        auto_approve: true,
        dispatch_repo_root: dir,
        validator: {
          enabled: true,
          agent_type: "codex",
          mode: "bridge",
          auto_approve: false,
          threshold_type: "score",
          pass_threshold: 0.8,
          max_fix_cycles: 4,
          base_branch: "main"
        }
      },
      [{ status: "⬜", worker: "N-04", model: "CODEX-HIGH", notes: "Single module" }],
      "N-04",
      launchWorker
    );

    expect(result).toMatchObject({
      ok: true,
      workerId: "N-04",
      threadId: "worker-thread-n04"
    });
    expect(launchWorker).toHaveBeenCalledWith(expect.objectContaining({
      workerId: "N-04",
      validationMaxFixCycles: 4
    }));
  });

  it("does not pass validator max cycles when a worker opts out of validation", async () => {
    const { dir, planPath, commandPath } = await createTempDispatchPlan();
    const launchWorker = vi.fn().mockResolvedValue({
      ok: true,
      threadId: "worker-thread-n04"
    });

    await continueDispatchWorker(
      {
        dispatch_plan_path: planPath,
        command_file_path: commandPath,
        mode: "bridge",
        agent_type: "codex",
        kill_policy: "always",
        auto_approve: true,
        dispatch_repo_root: dir,
        validator: {
          enabled: true,
          agent_type: "codex",
          mode: "bridge",
          auto_approve: false,
          threshold_type: "score",
          pass_threshold: 0.8,
          max_fix_cycles: 4,
          base_branch: "main"
        }
      },
      [{ status: "⬜", worker: "N-04", model: "CODEX-HIGH", notes: "validate: off" }],
      "N-04",
      launchWorker
    );

    expect(launchWorker).toHaveBeenCalledWith(expect.objectContaining({
      workerId: "N-04",
      validationMaxFixCycles: undefined
    }));
  });

  it("passes parsed model::effort as effort when launching a worker", async () => {
    const { dir, commandPath, planPath } = await createTempDispatchPlan();
    const launchWorker = vi.fn().mockResolvedValue({
      ok: true,
      threadId: "worker-thread-n04"
    });
    await fsPromises.writeFile(planPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| ⬜ | 1 | N-04 | Findings C | CODEX::high | N-01 | Single module |"
    ].join("\n"), "utf8");

    await continueDispatchWorker(
      {
        dispatch_plan_path: planPath,
        command_file_path: commandPath,
        mode: "bridge",
        agent_type: "codex",
        kill_policy: "always",
        auto_approve: true,
        dispatch_repo_root: dir,
        validator: {
          enabled: true,
          agent_type: "codex",
          mode: "bridge",
          auto_approve: false,
          threshold_type: "score",
          pass_threshold: 0.8,
          max_fix_cycles: 4,
          base_branch: "main"
        }
      },
      [{ status: "⬜", worker: "N-04", model: "CODEX::high", notes: "Single module" }],
      "N-04",
      launchWorker
    );

    expect(launchWorker).toHaveBeenCalledWith(expect.objectContaining({
      workerId: "N-04",
      effort: "high",
      modelId: "gpt-5.4 medium"
    }));
  });

  it("uses persisted runtime model/effort overrides when continuing a worker", async () => {
    const { dir, commandPath, planPath } = await createTempDispatchPlan();
    const sidecarPath = path.join(dir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, {
      dispatchPlanPath: planPath
    });
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-05T00:00:00.000Z",
        status: "running"
      },
      workers: {
        "N-04": {
          thread_id: "worker-thread-456",
          trace_id: "11111111-1111-4111-8111-111111111111",
          started_at: "2026-04-05T00:00:00.000Z",
          last_seen_at: "2026-04-05T00:10:00.000Z",
          // Status is not `running` so the running-with-thread short-circuit
          // doesn't fire, while the plan row below stays launchable without
          // invoking the real resume-worker gateway.
          status: "abandoned",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          applied_model_id: "gpt-5.5",
          applied_reasoning_effort: "xhigh"
        }
      },
      last_reconciled_at: null
    });
    const launchWorker = vi.fn().mockResolvedValue({
      ok: true,
      threadId: "worker-thread-n04"
    });

    await continueDispatchWorker(
      {
        dispatch_plan_path: planPath,
        command_file_path: commandPath,
        mode: "bridge",
        agent_type: "codex",
        kill_policy: "always",
        auto_approve: true,
        dispatch_repo_root: dir,
        validator: {
          enabled: true,
          agent_type: "codex",
          mode: "bridge",
          auto_approve: false,
          threshold_type: "score",
          pass_threshold: 0.8,
          max_fix_cycles: 4,
          base_branch: "main"
        }
      },
      [{ status: "⬜", worker: "N-04", model: "CODEX-HIGH", notes: "Single module" }],
      "N-04",
      launchWorker
    );

    expect(launchWorker).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "gpt-5.5",
      effort: "xhigh"
    }));
  });

  it("does not relaunch a running worker that already owns a thread", async () => {
    // Regression for agent-dispatcher-4db5c870: after a service restart
    // the lifecycle could have C-01 recorded as `running` with a thread_id
    // (possibly already dead per Hub, but the reconciler hadn't run yet).
    // Without a short-circuit, continueDispatchWorker would happily reset
    // the row and spawn a parallel agent every continue tick, producing
    // the "endless new spawns for the same work" footprint the operator
    // reported. The reconciler / watchdog is responsible for transitioning
    // a stale running entry to abandoned; until then, leave it alone.
    const { dir, commandPath, planPath } = await createTempDispatchPlan();
    const sidecarPath = path.join(dir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, {
      dispatchPlanPath: planPath
    });
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-running",
        started_at: "2026-05-09T00:00:00.000Z",
        status: "running"
      },
      workers: {
        "C-01": {
          thread_id: "worker-thread-already-running",
          trace_id: "11111111-1111-4111-8111-111111111111",
          started_at: "2026-05-09T00:00:00.000Z",
          last_seen_at: "2026-05-09T00:10:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });
    const launchWorker = vi.fn().mockResolvedValue({
      ok: true,
      threadId: "worker-thread-should-not-launch"
    });

    const result = await continueDispatchWorker(
      {
        dispatch_plan_path: planPath,
        command_file_path: commandPath,
        mode: "bridge",
        agent_type: "codex",
        kill_policy: "always",
        auto_approve: true,
        dispatch_repo_root: dir
      },
      [{ status: "🔄", worker: "C-01", model: "CODEX-HIGH" }],
      "C-01",
      launchWorker
    );

    expect(launchWorker).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      workerId: "C-01",
      threadId: "worker-thread-already-running"
    });
  });

  it("does not relaunch an abandoned worker after validator max cycles are exhausted", async () => {
    const { dir, commandPath, planPath } = await createTempDispatchPlan();
    const sidecarPath = path.join(dir, "dispatch_threads.json");
    const lifecycleStore = new LifecycleStore(sidecarPath, {
      dispatchPlanPath: planPath
    });
    lifecycleStore.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-exhausted",
        started_at: "2026-06-16T11:40:00.000Z",
        status: "running"
      },
      workers: {
        "N-04": {
          thread_id: "worker-thread-exhausted",
          trace_id: "11111111-1111-4111-8111-111111111111",
          started_at: "2026-06-16T11:40:00.000Z",
          last_seen_at: "2026-06-16T11:42:00.000Z",
          status: "abandoned",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          validation: {
            current_cycle: 18,
            max_fix_cycles: 5,
            validator_thread_id: null,
            last_score: 0.5,
            last_feedback: "max cycles exhausted",
            history: [],
            spawn_failure_count: 0,
            last_spawn_failure_at: null
          }
        }
      },
      last_reconciled_at: null
    });
    const launchWorker = vi.fn().mockResolvedValue({
      ok: true,
      threadId: "worker-thread-should-not-launch"
    });

    const result = await continueDispatchWorker(
      {
        dispatch_plan_path: planPath,
        command_file_path: commandPath,
        mode: "bridge",
        agent_type: "codex",
        kill_policy: "always",
        auto_approve: true,
        dispatch_repo_root: dir,
        validator: {
          enabled: true,
          agent_type: "codex",
          mode: "bridge",
          auto_approve: false,
          threshold_type: "score",
          pass_threshold: 0.8,
          max_fix_cycles: 5,
          base_branch: "main"
        }
      },
      [{ status: "⚠️ ABANDONED", worker: "N-04", model: "CODEX-HIGH" }],
      "N-04",
      launchWorker
    );

    expect(result).toEqual({
      ok: false,
      workerId: "N-04",
      error: "validation max cycles exhausted for worker N-04"
    });
    expect(launchWorker).not.toHaveBeenCalled();
    expect(lifecycleStore.load().workers["N-04"]?.retry_count).toBe(0);
  });
  // Regression: unification-layer-decoupling-2026-08-06 / BATCH-8-GATE.
  // continueDispatchWorker is the single funnel every launch reaches (serial
  // continue, parallel slot filler, scheduler role), so it carries the
  // escalation-freeze backstop: a new caller that skips the upstream
  // eligibility gate still cannot spawn a row a human has been asked to rule on.
  describe("escalation freeze backstop", () => {
    const escalationEntry = (overrides: Record<string, unknown> = {}) => ({
      thread_id: "pm-thread-escalated",
      status: "failed" as const,
      started_at: "2026-08-06T20:50:00.000Z",
      last_seen_at: "2026-08-06T20:58:53.000Z",
      agent_type: "codex",
      model_id: null,
      mode: "bridge",
      auto_approve: true,
      issue: {
        status: "manual_intervention_required",
        worker_id: "N-04",
        message: "manual intervention required",
        error: null,
        source: "watchdog"
      },
      result: null,
      error: null,
      transport_error: null,
      marker_outcome: "escalated" as const,
      marker_pm_action: "escalate_human" as const,
      ...overrides
    });

    async function runContinue(
      humanResolution: { resolved_at: string; note: string | null } | null,
      pmOverrides: Record<string, unknown> = {}
    ) {
      const { dir, commandPath, planPath } = await createTempDispatchPlan();
      const sidecarPath = path.join(dir, "dispatch_threads.json");
      const lifecycleStore = new LifecycleStore(sidecarPath, { dispatchPlanPath: planPath });
      lifecycleStore.save({
        version: 2,
        dispatcher: {
          thread_id: "dispatcher-thread-123",
          started_at: "2026-08-06T20:00:00.000Z",
          status: "running"
        },
        workers: {
          "N-04": {
            thread_id: "",
            trace_id: null,
            started_at: "2026-08-06T20:00:00.000Z",
            last_seen_at: "2026-08-06T21:02:11.000Z",
            status: "pending",
            expected_outputs: [],
            hub_result: null,
            command_preamble: null,
            retry_count: 0,
            ...(humanResolution ? { human_resolution: humanResolution } : {})
          }
        },
        pm_resolvers: [escalationEntry(pmOverrides)],
        last_reconciled_at: null
      });
      const launchWorker = vi.fn().mockResolvedValue({
        ok: true,
        threadId: "worker-thread-launched"
      });

      const result = await continueDispatchWorker(
        {
          dispatch_plan_path: planPath,
          command_file_path: commandPath,
          mode: "bridge",
          agent_type: "codex",
          kill_policy: "always",
          auto_approve: true,
          dispatch_repo_root: dir
        },
        [{ status: "\u2b1c", worker: "N-04", model: "CODEX-HIGH" }],
        "N-04",
        launchWorker
      );

      return { result, launchWorker };
    }

    it("refuses to launch a row parked behind an unreleased escalate_human", async () => {
      const { result, launchWorker } = await runContinue(null);

      expect(result.ok).toBe(false);
      expect(result.workerId).toBe("N-04");
      expect(result.humanEscalationFreeze).toMatchObject({
        workerId: "N-04",
        pmResolverThreadId: "pm-thread-escalated",
        escalatedAt: "2026-08-06T20:58:53.000Z"
      });
      expect(result.error).toContain("awaiting human resolution");
      // Not a launch failure: callers must not retry it into a loop.
      expect(result.localToolBootstrapFailure).toBeUndefined();
      expect(launchWorker).not.toHaveBeenCalled();
    });

    it("launches normally once /human-resolve stamps a newer resolved_at", async () => {
      const { result, launchWorker } = await runContinue({
        resolved_at: "2026-08-06T23:10:00.000Z",
        note: "spec defect; acceptance relaxed by operator"
      });

      expect(result.ok).toBe(true);
      expect(result.humanEscalationFreeze).toBeUndefined();
      expect(launchWorker).toHaveBeenCalledTimes(1);
      expect(launchWorker.mock.calls[0]![0]).toMatchObject({ workerId: "N-04" });
    });

    it("leaves a row with a non-escalation PM outcome unaffected", async () => {
      const { result, launchWorker } = await runContinue(null, {
        status: "completed",
        marker_outcome: "resolved",
        marker_pm_action: "retry"
      });

      expect(result.ok).toBe(true);
      expect(result.humanEscalationFreeze).toBeUndefined();
      expect(launchWorker).toHaveBeenCalledTimes(1);
    });
  });
});
