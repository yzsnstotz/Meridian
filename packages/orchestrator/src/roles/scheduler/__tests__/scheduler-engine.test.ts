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
const execFileSyncMock = vi.hoisted(() => vi.fn(() => ""));

vi.mock("../../../tool-gateway/tools/continue-dispatcher", () => ({
  executeContinueDispatcher: executeContinueDispatcherMock
}));
vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock
}));

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue("");
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

  it("resumes a manual-intervention active run so recovery polling can continue", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-engine-"));
    tempDirectories.add(directory);

    const planPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(planPath, "", "utf8");

    const stateStore = new SchedulerStateStore(planPath);
    stateStore.save({
      ...buildEmptyRunState(),
      status: "manual_intervention_required",
      current_run_id: "run-001",
      last_run_outcome: "manual_intervention_required"
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

    engine.resume();

    expect(stateStore.load()).toMatchObject({
      status: "active_run",
      current_run_id: "run-001"
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

  it("recovers a failed worker without a hub result from its current-run completion report before continuing", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-engine-"));
    tempDirectories.add(directory);

    const planPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(planPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends on | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| ✅ | 1 | W-CATALOG | Catalog sweep | CODEX-HIGH | — | |",
      "| ❌ | 2 | W-DETAIL | clawhub-fetch detail-fetch --scan-run-id ${SCAN_RUN_ID} | CODEX-HIGH | W-CATALOG | |",
      "| ⬜ | 3 | W-SSR | SSR enrich | CODEX-HIGH | W-DETAIL | |"
    ].join("\n"), "utf8");

    const runReportDir = path.join(directory, "reports", "runs", "run-001");
    await fs.mkdir(runReportDir, { recursive: true });
    const reportPath = path.join(runReportDir, "W-DETAIL.md");
    await fs.writeFile(reportPath, [
      "# W-DETAIL Completion Report",
      "",
      "- Worker ID: W-DETAIL",
      "- Status: completed",
      "",
      "## Exit Code",
      "",
      "- AI Auto-Test/reconciliation exit code: 0",
      "",
      "## JSON Summary Output",
      "",
      "```json",
      "{",
      "  \"success\": 865,",
      "  \"failed\": 21,",
      "  \"skipped\": 476,",
      "  \"skipped_existing\": 476",
      "}",
      "```",
      "",
      "## AI Auto-Test Results",
      "",
      "```text",
      "PASS: manifest exists",
      "PASS: clawhub-fetch detail-fetch exited 0",
      "PASS: progress status is completed",
      "PASS: processed count equals total count: 1362 == 1362",
      "PASS: remaining count is 0",
      "INFO: 21 package/version/file payloads were unavailable from the upstream API and were recorded by the CLI during the run.",
      "```"
    ].join("\n"), "utf8");

    const lifecycleStore = new LifecycleStore(path.join(directory, "dispatch_threads.json"));
    lifecycleStore.save({
      ...buildEmptyDispatchThreadStateV2(),
      workers: {
        "W-CATALOG": {
          thread_id: "thread-catalog",
          trace_id: null,
          started_at: "2026-04-28T20:00:00.000Z",
          last_seen_at: "2026-04-28T20:05:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "W-DETAIL": {
          thread_id: "thread-detail",
          trace_id: null,
          started_at: "2026-04-28T21:00:00.000Z",
          last_seen_at: "2026-04-28T21:30:00.000Z",
          status: "failed",
          expected_outputs: [reportPath],
          hub_result: null,
          command_preamble: null,
          retry_count: 2
        }
      }
    });

    const stateStore = new SchedulerStateStore(planPath);
    stateStore.save({
      ...buildEmptyRunState(),
      status: "active_run",
      current_run_id: "run-001",
      current_run_report_dir: null,
      current_scan_run_id: "daily-2026-04-29"
    });

    const continueWorker = vi.fn(async () => ({
      ok: true,
      workerId: "W-SSR",
      threadId: "thread-ssr"
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

    expect(lifecycleStore.load().workers["W-DETAIL"]).toMatchObject({
      status: "completed",
      hub_result: expect.objectContaining({
        status: "success"
      })
    });
    expect(continueWorker).toHaveBeenCalledWith(expect.objectContaining({
      dispatch_plan_path: planPath
    }), "W-SSR");
  });

  it("does not recover a completion report while tool progress is still running", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-engine-"));
    tempDirectories.add(directory);

    const progressPath = path.join(directory, "detail-fetch.progress.json");
    const planPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(planPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends on | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      `| 🔄 | 1 | W-01 | clawhub-fetch detail-fetch --progress ${progressPath} | CODEX-HIGH | — | |`,
      "| ⬜ | 2 | W-02 | Second worker | CODEX-HIGH | W-01 | |"
    ].join("\n"), "utf8");
    await fs.writeFile(progressPath, `${JSON.stringify({
      command: "detail-fetch",
      scan_run_id: "daily-2026-04-27",
      status: "running",
      total: 10,
      processed: 4,
      success: 4,
      failed: 0,
      skipped: 0,
      remaining: 6,
      updated_at: "2026-04-27T02:30:00.000Z"
    }, null, 2)}\n`, "utf8");

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

    expect(lifecycleStore.load().workers["W-01"]?.status).toBe("running");
    expect(continueWorker).not.toHaveBeenCalled();
  });

  it("pauses for manual intervention when a failed tool progress blocks downstream workers", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-engine-"));
    tempDirectories.add(directory);

    const progressPath = path.join(directory, "detail-fetch.progress.json");
    const planPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(planPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends on | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| ✅ | 1 | W-CATALOG | First worker | CODEX-HIGH | — | |",
      `| ✅ | 2 | W-DETAIL | clawhub-fetch detail-fetch --progress ${progressPath} | CODEX-HIGH | W-CATALOG | |`,
      "| ⬜ | 3 | W-SSR | Second worker | CODEX-HIGH | W-DETAIL | |"
    ].join("\n"), "utf8");
    await fs.writeFile(progressPath, `${JSON.stringify({
      command: "detail-fetch",
      scan_run_id: "daily-2026-04-27",
      status: "failed",
      total: 35324,
      processed: 35294,
      success: 35294,
      failed: 30,
      skipped: 0,
      remaining: 30,
      updated_at: "2026-04-27T13:35:12.774Z"
    }, null, 2)}\n`, "utf8");

    const lifecycleStore = new LifecycleStore(path.join(directory, "dispatch_threads.json"));
    lifecycleStore.save({
      ...buildEmptyDispatchThreadStateV2(),
      workers: {
        "W-CATALOG": {
          thread_id: "thread-catalog",
          trace_id: null,
          started_at: "2026-04-26T06:00:00.000Z",
          last_seen_at: "2026-04-26T06:10:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "W-DETAIL": {
          thread_id: "thread-detail",
          trace_id: null,
          started_at: "2026-04-26T07:00:00.000Z",
          last_seen_at: "2026-04-26T07:10:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 2
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
      workerId: "W-SSR",
      threadId: "thread-ssr"
    }));
    const notifyChannels = vi.fn();
    const engine = new SchedulerEngine({
      schedulerThreadId: "scheduler-test",
      config: buildConfig(planPath),
      stateStore,
      callbacks: {
        launchDispatcher: vi.fn(),
        killDispatcher: vi.fn(),
        notifyChannels,
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

    expect(continueWorker).not.toHaveBeenCalled();
    expect(stateStore.load()).toMatchObject({
      status: "manual_intervention_required",
      last_run_outcome: "manual_intervention_required"
    });
    expect(notifyChannels).toHaveBeenCalledWith(expect.objectContaining({
      dispatch_plan_path: planPath
    }), expect.stringContaining("W-DETAIL"));
  });

  it("does not keep an active run blocked by a dead running progress file", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-engine-"));
    tempDirectories.add(directory);

    const progressPath = path.join(directory, "ssr-enrich.progress.json");
    const manifestPath = path.join(directory, "changed_skill_manifest.json");
    const planPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(planPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends on | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| ✅ | 2 | W-DETAIL | Detail fetch | CODEX-HIGH | — | |",
      `| 🔄 | 3 | W-SSR | clawhub-fetch ssr-enrich --scan-run-id daily-dead-progress-test --manifest ${manifestPath} --progress ${progressPath} | CODEX-HIGH | W-DETAIL | |`,
      "| ⬜ | 4 | W-PERSIST | Persist | CODEX-HIGH | W-SSR | |"
    ].join("\n"), "utf8");
    await fs.writeFile(progressPath, `${JSON.stringify({
      command: "ssr-enrich",
      scan_run_id: "daily-dead-progress-test",
      status: "running",
      manifest_path: manifestPath,
      total: 13075,
      processed: 4699,
      success: 0,
      failed: 15,
      skipped: 4684,
      remaining: 8376,
      updated_at: "2026-05-02T07:18:16.453Z",
      pid: 999999
    }, null, 2)}\n`, "utf8");

    const lifecycleStore = new LifecycleStore(path.join(directory, "dispatch_threads.json"));
    lifecycleStore.save({
      ...buildEmptyDispatchThreadStateV2(),
      workers: {
        "W-DETAIL": {
          thread_id: "thread-detail",
          trace_id: null,
          started_at: "2026-05-02T05:00:00.000Z",
          last_seen_at: "2026-05-02T05:10:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "W-SSR": {
          thread_id: "thread-ssr",
          trace_id: null,
          started_at: "2026-05-02T06:00:00.000Z",
          last_seen_at: "2026-05-02T06:10:00.000Z",
          status: "abandoned",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 2
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
      workerId: "W-SSR",
      threadId: "thread-ssr-retry"
    }));
    const notifyChannels = vi.fn();
    const engine = new SchedulerEngine({
      schedulerThreadId: "scheduler-test",
      config: buildConfig(planPath),
      stateStore,
      callbacks: {
        launchDispatcher: vi.fn(),
        killDispatcher: vi.fn(),
        notifyChannels,
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

    expect(continueWorker).not.toHaveBeenCalled();
    expect(stateStore.load()).toMatchObject({
      status: "manual_intervention_required",
      last_run_outcome: "manual_intervention_required"
    });
    expect(notifyChannels).toHaveBeenCalledWith(expect.objectContaining({
      dispatch_plan_path: planPath
    }), expect.stringContaining("W-SSR"));
  });

  it("does not recover a current-run report while the matching tool process is still running", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-engine-"));
    tempDirectories.add(directory);

    const planPath = path.join(directory, "dispatch_plan.md");
    const scanRunId = "daily-2026-04-27";
    await fs.writeFile(planPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends on | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      `| 🔄 | 2 | W-DETAIL | clawhub-fetch detail-fetch --scan-run-id \${SCAN_RUN_ID} --db /Volumes/Elements/clawhub/clawhub.db --manifest /tmp/clawhub-scan/\${SCAN_RUN_ID}/changed_skill_manifest.json | CODEX-HIGH | W-CATALOG | |`,
      "| ⬜ | 3 | W-SSR | clawhub-fetch ssr-enrich --scan-run-id ${SCAN_RUN_ID} --db /Volumes/Elements/clawhub/clawhub.db --manifest /tmp/clawhub-scan/${SCAN_RUN_ID}/changed_skill_manifest.json --enrichment-path /tmp/clawhub-scan/${SCAN_RUN_ID}/enrichment.json | CODEX-HIGH | W-DETAIL | |"
    ].join("\n"), "utf8");

    const runReportDir = path.join(directory, "reports", "runs", "run-001");
    await fs.mkdir(runReportDir, { recursive: true });
    const reportPath = path.join(runReportDir, "W-DETAIL.md");
    await fs.writeFile(reportPath, [
      "# W-DETAIL Completion Report",
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
        "W-CATALOG": {
          thread_id: "thread-catalog",
          trace_id: null,
          started_at: "2026-04-26T16:00:00.000Z",
          last_seen_at: "2026-04-26T16:10:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "W-DETAIL": {
          thread_id: "managed-W-DETAIL-daily-2026-04-27-71436",
          trace_id: null,
          started_at: "2026-04-26T17:00:00.000Z",
          last_seen_at: "2026-04-26T17:10:00.000Z",
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
      current_run_report_dir: null,
      current_scan_run_id: scanRunId
    });

    execFileSyncMock.mockReturnValue([
      `71436 node /home/tester/.local/share/fnm/aliases/default/bin/clawhub-fetch detail-fetch --scan-run-id ${scanRunId} --db /Volumes/Elements/clawhub/clawhub.db --manifest /tmp/clawhub-scan/${scanRunId}/W-DETAIL.remaining-managed.json`
    ].join("\n"));

    const continueWorker = vi.fn(async () => ({
      ok: true,
      workerId: "W-SSR",
      threadId: "thread-ssr"
    }));
    const engine = new SchedulerEngine({
      schedulerThreadId: "scheduler-test",
      config: {
        ...buildConfig(planPath),
        scan_run_id_strategy: "daily-date",
        scan_run_id_prefix: "daily"
      },
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

    expect(lifecycleStore.load().workers["W-DETAIL"]?.status).toBe("running");
    expect(continueWorker).not.toHaveBeenCalled();
  });

  it("does not recover a running worker from stale current-run output written before the worker started", async () => {
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
      "✅",
      "",
      "This is a stale report from an earlier attempt."
    ].join("\n"), "utf8");
    await fs.utimes(
      reportPath,
      new Date("2026-04-26T05:59:00.000Z"),
      new Date("2026-04-26T05:59:00.000Z")
    );

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

    expect(lifecycleStore.load().workers["W-01"]?.status).toBe("running");
    expect(continueWorker).not.toHaveBeenCalled();
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

  it("does not retry a terminal-worker kill after the hub reports the thread is no longer registered", async () => {
    // Regression: the scheduler engine kept its own local missing-thread
    // matcher (mirror of the watchdog bug fixed alongside this test). Both
    // now share the canonical matcher so a hub "No registered agent
    // instance found" reply marks the thread cleaned instead of looping.
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
          thread_id: "thread-w01-stale",
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

    const killDispatcher = vi.fn(async () => {
      throw new Error(
        "kill failed: Routing failed: No registered agent instance found for thread_id=thread-w01-stale"
      );
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

    const runCycleCompletion = () =>
      (engine as unknown as { checkCycleCompletion(): Promise<void> }).checkCycleCompletion();

    await runCycleCompletion();
    expect(killDispatcher).toHaveBeenCalledTimes(1);

    // Second invocation must not re-attempt the same kill — the hub already
    // said the thread is gone, so it must be considered cleaned.
    await runCycleCompletion();
    expect(killDispatcher).toHaveBeenCalledTimes(1);
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
    mode: "bridge",
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
