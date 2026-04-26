import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SchedulerEngine } from "../scheduler-engine";
import { SchedulerStateStore, buildEmptyRunState } from "../scheduler-state-store";
import { buildEmptyDispatchThreadStateV2, LifecycleStore } from "../../agent-dispatcher/lifecycle-store";
import type { SchedulerConfig } from "../../../types";

const tempDirectories = new Set<string>();
const executeContinueDispatcherMock = vi.hoisted(() => vi.fn(async () => ({
  ok: false,
  error: "legacy dispatcher route should not be used"
})));

vi.mock("../../../tool-gateway/tools/continue-dispatcher", () => ({
  executeContinueDispatcher: executeContinueDispatcherMock
}));

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("SchedulerEngine", () => {
  it("does not reschedule a run that is waiting for manual intervention", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-engine-"));
    tempDirectories.add(directory);

    const planPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(planPath, "", "utf8");

    const stateStore = new SchedulerStateStore(planPath);
    stateStore.save({
      ...buildEmptyRunState(),
      status: "manual_intervention_required",
      last_run_outcome: "failed"
    });

    const engine = new SchedulerEngine({
      schedulerThreadId: "scheduler-test",
      config: buildConfig(planPath),
      stateStore,
      callbacks: {
        launchDispatcher: vi.fn(),
        killDispatcher: vi.fn(),
        notifyChannels: vi.fn()
      },
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      }
    });

    engine.start();

    expect(stateStore.load()).toMatchObject({
      status: "manual_intervention_required",
      next_run_at: null,
      last_run_outcome: "failed"
    });
  });

  it("reschedules a max-cycle scheduler when config now allows more cycles", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-engine-"));
    tempDirectories.add(directory);

    const planPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(planPath, "", "utf8");

    const stateStore = new SchedulerStateStore(planPath);
    stateStore.save({
      ...buildEmptyRunState(),
      status: "completed_max_cycles",
      completed_cycles: 2,
      last_run_outcome: "completed"
    });

    const engine = new SchedulerEngine({
      schedulerThreadId: "scheduler-test",
      config: {
        ...buildConfig(planPath),
        max_cycles: 5
      },
      stateStore,
      callbacks: {
        launchDispatcher: vi.fn(),
        killDispatcher: vi.fn(),
        notifyChannels: vi.fn()
      },
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      }
    });

    engine.start();

    expect(stateStore.load()).toMatchObject({
      status: "waiting",
      completed_cycles: 2,
      last_run_outcome: "completed"
    });
    expect(stateStore.load().next_run_at).toEqual(expect.any(String));
  });

  it("continues the next eligible worker directly during an active scheduler run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T07:00:00.000Z"));

    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-engine-"));
    tempDirectories.add(directory);

    const planPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(planPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends on | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| ✅ | 1 | W-01 | First worker | CODEX-HIGH | — | |",
      "| ⬜ | 1 | W-02 | Second worker | CODEX-HIGH | W-01 | |"
    ].join("\n"), "utf8");

    const lifecycleStore = new LifecycleStore(path.join(directory, "dispatch_threads.json"));
    lifecycleStore.save({
      ...buildEmptyDispatchThreadStateV2(),
      workers: {
        "W-01": {
          thread_id: "thread-w01",
          trace_id: null,
          started_at: "2026-04-26T06:00:00.000Z",
          last_seen_at: "2026-04-26T06:10:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const stateStore = new SchedulerStateStore(planPath);
    stateStore.save({
      ...buildEmptyRunState(),
      status: "active_run",
      current_run_id: "run-001"
    });

    const continueWorker = vi.fn(async () => ({
      ok: true,
      workerId: "W-02",
      threadId: "thread-w02"
    }));
    const engine = new SchedulerEngine({
      schedulerThreadId: "scheduler-test",
      config: buildConfig(planPath),
      stateStore,
      callbacks: {
        launchDispatcher: vi.fn(),
        killDispatcher: vi.fn(),
        notifyChannels: vi.fn(),
        continueWorker
      },
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      }
    });

    await (engine as unknown as { checkCycleCompletion(): Promise<void> }).checkCycleCompletion();

    expect(executeContinueDispatcherMock).not.toHaveBeenCalled();
    expect(continueWorker).toHaveBeenCalledWith(expect.objectContaining({
      dispatch_plan_path: planPath
    }), "W-02");
  });

  it("recovers a running worker from its fallback current-run completion report before continuing", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-engine-"));
    tempDirectories.add(directory);

    const planPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(planPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends on | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| ✅ | 0 | W-00 | Preflight | CODEX-HIGH | — | |",
      "| 🔄 | 1 | W-01 | First worker | CODEX-HIGH | W-00 | |",
      "| ⬜ | 2 | W-02 | Second worker | CODEX-HIGH | W-01 | |"
    ].join("\n"), "utf8");

    const runReportDir = path.join(directory, "reports", "runs", "run-001");
    await fs.mkdir(runReportDir, { recursive: true });
    const reportPath = path.join(runReportDir, "W-01.md");
    await fs.writeFile(reportPath, [
      "# W-01 Completion Report",
      "",
      "## Outcome",
      "",
      "✅",
      "",
      "All acceptance checks passed."
    ].join("\n"), "utf8");

    const lifecycleStore = new LifecycleStore(path.join(directory, "dispatch_threads.json"));
    lifecycleStore.save({
      ...buildEmptyDispatchThreadStateV2(),
      workers: {
        "W-00": {
          thread_id: "thread-w00",
          trace_id: null,
          started_at: "2026-04-26T05:00:00.000Z",
          last_seen_at: "2026-04-26T05:01:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "W-01": {
          thread_id: "thread-w01",
          trace_id: null,
          started_at: "2026-04-26T06:00:00.000Z",
          last_seen_at: "2026-04-26T06:01:00.000Z",
          status: "running",
          expected_outputs: [reportPath],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const stateStore = new SchedulerStateStore(planPath);
    stateStore.save({
      ...buildEmptyRunState(),
      status: "active_run",
      current_run_id: "run-001",
      current_run_report_dir: null
    });

    const continueWorker = vi.fn(async () => ({
      ok: true,
      workerId: "W-02",
      threadId: "thread-w02"
    }));
    const engine = new SchedulerEngine({
      schedulerThreadId: "scheduler-test",
      config: buildConfig(planPath),
      stateStore,
      callbacks: {
        launchDispatcher: vi.fn(),
        killDispatcher: vi.fn(),
        notifyChannels: vi.fn(),
        continueWorker
      },
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      }
    });

    await (engine as unknown as { checkCycleCompletion(): Promise<void> }).checkCycleCompletion();

    expect(lifecycleStore.load().workers["W-01"]?.status).toBe("completed");
    expect(continueWorker).toHaveBeenCalledWith(expect.objectContaining({
      dispatch_plan_path: planPath
    }), "W-02");
  });

  it("kills a recovered completed worker before continuing the next scheduler worker", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-engine-"));
    tempDirectories.add(directory);

    const planPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(planPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends on | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| 🔄 | 1 | W-01 | First worker | CODEX-HIGH | — | |",
      "| ⬜ | 2 | W-02 | Second worker | CODEX-HIGH | W-01 | |"
    ].join("\n"), "utf8");

    const runReportDir = path.join(directory, "reports", "runs", "run-001");
    await fs.mkdir(runReportDir, { recursive: true });
    const reportPath = path.join(runReportDir, "W-01.md");
    await fs.writeFile(reportPath, [
      "# W-01 Completion Report",
      "",
      "## Outcome",
      "",
      "✅"
    ].join("\n"), "utf8");

    const lifecycleStore = new LifecycleStore(path.join(directory, "dispatch_threads.json"));
    lifecycleStore.save({
      ...buildEmptyDispatchThreadStateV2(),
      workers: {
        "W-01": {
          thread_id: "thread-w01",
          trace_id: null,
          started_at: "2026-04-26T06:00:00.000Z",
          last_seen_at: "2026-04-26T06:01:00.000Z",
          status: "running",
          expected_outputs: [reportPath],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      }
    });

    const stateStore = new SchedulerStateStore(planPath);
    stateStore.save({
      ...buildEmptyRunState(),
      status: "active_run",
      current_run_id: "run-001",
      current_run_report_dir: null
    });

    const killDispatcher = vi.fn(async () => undefined);
    const continueWorker = vi.fn(async () => ({
      ok: true,
      workerId: "W-02",
      threadId: "thread-w02"
    }));
    const engine = new SchedulerEngine({
      schedulerThreadId: "scheduler-test",
      config: buildConfig(planPath),
      stateStore,
      callbacks: {
        launchDispatcher: vi.fn(),
        killDispatcher,
        notifyChannels: vi.fn(),
        continueWorker
      },
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      }
    });

    await (engine as unknown as { checkCycleCompletion(): Promise<void> }).checkCycleCompletion();

    expect(lifecycleStore.load().workers["W-01"]?.status).toBe("completed");
    expect(killDispatcher).toHaveBeenCalledWith("thread-w01");
    expect(continueWorker).toHaveBeenCalledWith(expect.objectContaining({
      dispatch_plan_path: planPath
    }), "W-02");
  });
});

function buildConfig(dispatchPlanPath: string): SchedulerConfig {
  return {
    dispatch_plan_path: dispatchPlanPath,
    command_file_path: path.join(path.dirname(dispatchPlanPath), "agent_dispatch_command.md"),
    dispatch_repo_root: path.dirname(dispatchPlanPath),
    docs_root: path.dirname(dispatchPlanPath),
    user_reply_channels: [{ channel: "web", chat_id: "web:ops" }],
    agent_type: "codex",
    mode: "pane_bridge",
    kill_policy: "always",
    auto_approve: true,
    scheduler_mode: "cron",
    cron_expression: "0 6 * * *",
    timezone: "Asia/Tokyo",
    delay_between_cycles_seconds: 0,
    report_base_dir: path.join(path.dirname(dispatchPlanPath), "reports"),
    catch_up_policy: "skip_missed"
  };
}
