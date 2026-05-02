import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { completeCycle, detectCycleCompletion, startCycle } from "../cycle-manager";
import { SchedulerStateStore, buildEmptyRunState } from "../scheduler-state-store";
import type { SchedulerConfig } from "../../../types";

const tempDirectories = new Set<string>();

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("detectCycleCompletion", () => {
  it("records active run timing and clears stale next_run_at when a cycle starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T22:30:03.000Z"));
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-cycle-"));
    tempDirectories.add(directory);
    const plannedStartTime = "2026-04-29T22:30:00.000Z";

    const planPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(planPath, [
      "| Status | batch | worker | task | model | depends_on |",
      "|--------|-------|--------|------|-------|------------|",
      "| ✅ | 0 | PRE-FLIGHT | Environment Health Check | CODEX-HIGH | — |",
      ""
    ].join("\n"), "utf8");

    const stateStore = new SchedulerStateStore(planPath);
    stateStore.save({
      ...buildEmptyRunState(),
      status: "waiting",
      next_run_at: "2026-04-29T22:30:00.000Z"
    });

    const result = startCycle(stateStore, buildConfig(planPath), "scheduler-1", "run-001", plannedStartTime);

    expect(result).toEqual({ ok: true, run_id: "run-001" });
    expect(stateStore.load()).toMatchObject({
      status: "active_run",
      current_run_id: "run-001",
      current_run_planned_start_time: plannedStartTime,
      current_run_actual_start_time: "2026-04-29T22:30:03.000Z",
      next_run_at: null
    });
  });

  it("archives active run timing instead of stale waiting timestamps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T05:31:48.000Z"));
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-cycle-"));
    tempDirectories.add(directory);

    const planPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(planPath, [
      "| Status | batch | worker | task | model | depends_on |",
      "|--------|-------|--------|------|-------|------------|",
      "| ✅ | 0 | PRE-FLIGHT | Environment Health Check | CODEX-HIGH | — |",
      ""
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(directory, "dispatch_threads.json"), `${JSON.stringify({
      version: 2,
      dispatcher: { thread_id: "dispatcher-thread", started_at: null, status: "completed" },
      workers: {
        "PRE-FLIGHT": {
          thread_id: "worker-thread",
          trace_id: null,
          started_at: "2026-04-29T05:00:30.000Z",
          last_seen_at: "2026-04-29T05:02:30.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    const stateStore = new SchedulerStateStore(planPath);
    stateStore.save({
      ...buildEmptyRunState(),
      status: "active_run",
      current_run_id: "run-001",
      current_run_report_dir: path.join(directory, "reports", "runs", "run-001"),
      current_dispatcher_thread_id: "dispatcher-thread",
      current_run_planned_start_time: "2026-04-29T05:00:00.000Z",
      current_run_actual_start_time: "2026-04-29T05:00:00.000Z",
      next_run_at: "2026-04-29T22:30:00.000Z",
      last_run_completed_at: "2026-04-28T18:26:17.381Z",
      plan_lock_owner: "scheduler-1"
    } as ReturnType<typeof buildEmptyRunState>);

    const result = completeCycle(stateStore, buildConfig(planPath), "scheduler-1");

    expect(result.terminal_outcome).toBe("completed");
    const summary = JSON.parse(
      await fs.readFile(path.join(directory, "reports", "runs", "run-001", "report.json"), "utf8")
    );
    expect(summary).toMatchObject({
      planned_start_time: "2026-04-29T05:00:00.000Z",
      actual_start_time: "2026-04-29T05:00:00.000Z",
      completed_time: "2026-04-29T05:31:48.000Z",
      duration_seconds: 1908
    });
    expect(stateStore.load()).toMatchObject({
      current_run_planned_start_time: null,
      current_run_actual_start_time: null,
      next_run_at: null
    });
  });

  it("records an active run report directory under reports/runs/<run_id>", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-cycle-"));
    tempDirectories.add(directory);

    const planPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(planPath, [
      "| Status | batch | worker | task | model | depends_on |",
      "|--------|-------|--------|------|-------|------------|",
      "| ✅ | 0 | PRE-FLIGHT | Environment Health Check | CODEX-HIGH | — |",
      ""
    ].join("\n"), "utf8");

    const stateStore = new SchedulerStateStore(planPath);
    stateStore.save(buildEmptyRunState());
    const result = startCycle(stateStore, buildConfig(planPath), "scheduler-1", "run-001");

    expect(result).toEqual({ ok: true, run_id: "run-001" });
    expect(stateStore.load()).toMatchObject({
      status: "active_run",
      current_run_id: "run-001",
      current_run_report_dir: path.join(directory, "reports", "runs", "run-001")
    });
  });

  it("derives a stable daily scan run id from explicit scheduler config", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "routine-job-scheduler-cycle-"));
    tempDirectories.add(directory);

    const planPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(planPath, [
      "| Status | batch | worker | task | model | depends_on |",
      "|--------|-------|--------|------|-------|------------|",
      "| ✅ | 0 | PRE-FLIGHT | Environment Health Check | CODEX-HIGH | — |",
      ""
    ].join("\n"), "utf8");

    const stateStore = new SchedulerStateStore(planPath);
    stateStore.save(buildEmptyRunState());
    const result = startCycle(
      stateStore,
      buildConfig(planPath, {
        scan_run_id_strategy: "daily-date",
        scan_run_id_prefix: "daily"
      } as Partial<SchedulerConfig>),
      "scheduler-1",
      "run-001",
      "2026-04-24T21:00:00.000Z"
    );

    expect(result).toEqual({ ok: true, run_id: "run-001" });
    expect(stateStore.load()).toMatchObject({
      status: "active_run",
      current_run_id: "run-001",
      current_scan_run_id: "daily-2026-04-25"
    });
  });

  it("does not complete when lowercase plan rows are missing lifecycle entries", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-cycle-"));
    tempDirectories.add(directory);

    const planPath = path.join(directory, "clawhub-skill-scan-plan.md");
    await fs.writeFile(planPath, [
      "| Status | batch | worker | task | model | depends_on |",
      "|--------|-------|--------|------|-------|------------|",
      "| ✅ | 0 | PRE-FLIGHT | Environment Health Check | CODEX-HIGH | — |",
      "| ⬜ | 1 | W-CATALOG | Catalog Sweep | CODEX-HIGH | PRE-FLIGHT |",
      ""
    ].join("\n"), "utf8");

    await fs.writeFile(path.join(directory, "dispatch_threads.json"), `${JSON.stringify({
      version: 2,
      dispatcher: { thread_id: "dispatcher-thread", started_at: null, status: "completed" },
      workers: {
        DISPATCHER: {
          thread_id: "dispatcher-thread",
          trace_id: null,
          started_at: "2026-04-24T19:00:00.000Z",
          last_seen_at: "2026-04-24T19:01:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          retry_count: 0
        },
        "PRE-FLIGHT": {
          thread_id: "worker-thread",
          trace_id: null,
          started_at: "2026-04-24T19:02:00.000Z",
          last_seen_at: "2026-04-24T19:03:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    expect(detectCycleCompletion(buildConfig(planPath))).toEqual({ complete: false });
  });

  it("ignores an abandoned synthetic dispatcher lifecycle row when plan workers completed", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-cycle-"));
    tempDirectories.add(directory);

    const planPath = path.join(directory, "github-opc-scan-plan.md");
    await fs.writeFile(planPath, [
      "| Status | batch | worker | task | model | depends_on |",
      "|--------|-------|--------|------|-------|------------|",
      "| ✅ | 0 | PRE-FLIGHT | Environment Health Check | CODEX-HIGH | — |",
      "| ✅ | 1 | W-ANALYTICS | Write metrics and dashboard data | CODEX-HIGH | PRE-FLIGHT |",
      ""
    ].join("\n"), "utf8");

    await fs.writeFile(path.join(directory, "dispatch_threads.json"), `${JSON.stringify({
      version: 2,
      dispatcher: { thread_id: "dispatcher-thread", started_at: null, status: "abandoned" },
      workers: {
        DISPATCHER: {
          thread_id: "dispatcher-thread",
          trace_id: null,
          started_at: "2026-05-02T01:00:00.000Z",
          last_seen_at: "2026-05-02T01:01:00.000Z",
          status: "abandoned",
          expected_outputs: [],
          hub_result: null,
          retry_count: 0
        },
        "PRE-FLIGHT": {
          thread_id: "worker-thread-preflight",
          trace_id: null,
          started_at: "2026-05-02T01:02:00.000Z",
          last_seen_at: "2026-05-02T01:03:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          retry_count: 0
        },
        "W-ANALYTICS": {
          thread_id: "worker-thread-analytics",
          trace_id: null,
          started_at: "2026-05-02T01:04:00.000Z",
          last_seen_at: "2026-05-02T01:05:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    expect(detectCycleCompletion(buildConfig(planPath))).toEqual({ complete: true, outcome: "completed" });
  });

  it("treats completed lifecycle rows with failed worker reports as failed", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-cycle-"));
    tempDirectories.add(directory);

    const planPath = path.join(directory, "clawhub-skill-scan-plan.md");
    await fs.writeFile(planPath, [
      "| Status | batch | worker | task | model | depends_on |",
      "|--------|-------|--------|------|-------|------------|",
      "| ✅ | 1 | W-CATALOG | Catalog Sweep | CODEX-HIGH | PRE-FLIGHT |",
      ""
    ].join("\n"), "utf8");

    await fs.writeFile(path.join(directory, "dispatch_threads.json"), `${JSON.stringify({
      version: 2,
      dispatcher: { thread_id: "dispatcher-thread", started_at: null, status: "completed" },
      workers: {
        "W-CATALOG": {
          thread_id: "worker-thread",
          trace_id: null,
          started_at: "2026-04-24T19:02:00.000Z",
          last_seen_at: "2026-04-24T19:03:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: {
            thread_id: "worker-thread",
            trace_id: null,
            status: "success",
            run_state: "completed",
            content: "- Result: `⛔ FAILED`\n- Exit Code: `1`\nFAIL: manifest missing",
            summary_text: null,
            details_text: null,
            attachments: [],
            timestamp: "2026-04-24T19:03:00.000Z"
          },
          retry_count: 0
        }
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    expect(detectCycleCompletion(buildConfig(planPath))).toEqual({ complete: true, outcome: "failed" });
  });

  it("keeps scheduler cycles completed when success reports document negative cases", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-cycle-"));
    tempDirectories.add(directory);

    const planPath = path.join(directory, "clawhub-skill-scan-plan.md");
    await fs.writeFile(planPath, [
      "| Status | batch | worker | task | model | depends_on |",
      "|--------|-------|--------|------|-------|------------|",
      "| ✅ | 1 | W-CATALOG | Catalog Sweep | CODEX-HIGH | PRE-FLIGHT |",
      ""
    ].join("\n"), "utf8");

    await fs.writeFile(path.join(directory, "dispatch_threads.json"), `${JSON.stringify({
      version: 2,
      dispatcher: { thread_id: "dispatcher-thread", started_at: null, status: "completed" },
      workers: {
        "W-CATALOG": {
          thread_id: "worker-thread",
          trace_id: null,
          started_at: "2026-04-24T19:02:00.000Z",
          last_seen_at: "2026-04-24T19:03:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: {
            thread_id: "worker-thread",
            trace_id: null,
            status: "success",
            run_state: "completed",
            content: [
              "# W-CATALOG Completion Report",
              "",
              "- Status: ✅ Complete",
              "- Verified manifest missing handling.",
              "- No AI auto-tests failed.",
              "- Regression coverage documents command failed with exit code `1` copy."
            ].join("\n"),
            summary_text: null,
            details_text: null,
            attachments: [],
            timestamp: "2026-04-24T19:03:00.000Z"
          },
          retry_count: 0
        }
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    expect(detectCycleCompletion(buildConfig(planPath))).toEqual({ complete: true, outcome: "completed" });
  });

  it("keeps scheduler cycles completed when detail-fetch reports tolerated item failures", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-cycle-"));
    tempDirectories.add(directory);

    const planPath = path.join(directory, "clawhub-skill-scan-plan.md");
    await fs.writeFile(planPath, [
      "| Status | batch | worker | task | model | depends_on |",
      "|--------|-------|--------|------|-------|------------|",
      "| ✅ | 1 | W-DETAIL | Detail Fetch | CODEX-HIGH | W-CATALOG |",
      ""
    ].join("\n"), "utf8");

    await fs.writeFile(path.join(directory, "dispatch_threads.json"), `${JSON.stringify({
      version: 2,
      dispatcher: { thread_id: "dispatcher-thread", started_at: null, status: "completed" },
      workers: {
        "W-DETAIL": {
          thread_id: "worker-thread",
          trace_id: null,
          started_at: "2026-04-28T12:27:00.000Z",
          last_seen_at: "2026-04-28T12:56:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: {
            thread_id: "worker-thread",
            trace_id: null,
            status: "success",
            run_state: "completed",
            content: [
              "# W-DETAIL Completion Report",
              "",
              "- Worker ID: W-DETAIL",
              "- Exit code: 0",
              "",
              "## JSON Summary Output",
              "",
              "```json",
              "{",
              "  \"success\": 865,",
              "  \"failed\": 21,",
              "  \"skipped\": 12650,",
              "  \"skipped_existing\": 12650",
              "}",
              "```",
              "",
              "## AI Auto-Test Results",
              "",
              "- Detail fetch command completed with exit code 0: PASS",
              "- Processed count validation: PASS (`865 + 21 + 12650 = 13536`)",
              "",
              "## Notes",
              "",
              "- `clawhub-fetch` reported 21 per-skill failures and continued to successful command completion."
            ].join("\n"),
            summary_text: null,
            details_text: null,
            attachments: [],
            timestamp: "2026-04-28T12:56:00.000Z"
          },
          retry_count: 0
        }
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    expect(detectCycleCompletion(buildConfig(planPath))).toEqual({ complete: true, outcome: "completed" });
  });
});

function buildConfig(dispatchPlanPath: string, overrides: Partial<SchedulerConfig> = {}): SchedulerConfig {
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
    catch_up_policy: "skip_missed",
    ...overrides
  };
}
