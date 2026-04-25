import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { archiveRun } from "../archiver";
import type { SchedulerConfig } from "../../../types";

const tempDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("archiveRun", () => {
  it("archives configured report_base_dir worker reports and includes every plan worker", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-archive-"));
    tempDirectories.add(directory);

    const planPath = path.join(directory, "dispatch_plan.md");
    const reportBaseDir = path.join(directory, "reports");
    await fs.mkdir(reportBaseDir, { recursive: true });

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

    await fs.writeFile(path.join(reportBaseDir, "PRE-FLIGHT.md"), "# PRE-FLIGHT\n", "utf8");

    const result = archiveRun({
      runId: "run-001",
      config: buildConfig(planPath, reportBaseDir),
      actualStartTime: "2026-04-24T19:00:00.000Z",
      completedTime: "2026-04-24T19:05:00.000Z",
      dispatcherThreadId: "dispatcher-thread",
      terminalOutcome: "failed",
      completedCycles: 1,
      plannedStartTime: null
    });

    await expect(fs.access(path.join(result.archiveDir, "worker_outputs", "PRE-FLIGHT.md"))).resolves.toBeUndefined();

    const report = JSON.parse(await fs.readFile(result.jsonReportPath, "utf8"));
    expect(report.workers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        worker_id: "PRE-FLIGHT",
        status: "completed",
        report_path: path.join(result.archiveDir, "worker_outputs", "PRE-FLIGHT.md")
      }),
      expect.objectContaining({
        worker_id: "W-CATALOG",
        status: "⬜"
      })
    ]));
  });

  it("archives a lifecycle-rendered plan when worker output contradicts stale completed cells", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-archive-"));
    tempDirectories.add(directory);

    const planPath = path.join(directory, "dispatch_plan.md");
    const reportBaseDir = path.join(directory, "reports");
    await fs.mkdir(reportBaseDir, { recursive: true });

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
            trace_id: "728ec377-72b5-49d9-9fed-b2a1c2a15981",
            thread_id: "worker-thread",
            source: "codex",
            status: "success",
            run_state: "completed",
            content: "- Result: `⛔ FAILED`\n- Exit Code: `1`\nFAIL: manifest missing",
            attachments: [],
            timestamp: "2026-04-24T19:03:00.000Z"
          },
          retry_count: 0
        }
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    const result = archiveRun({
      runId: "run-002",
      config: buildConfig(planPath, reportBaseDir),
      actualStartTime: "2026-04-24T19:00:00.000Z",
      completedTime: "2026-04-24T19:05:00.000Z",
      dispatcherThreadId: "dispatcher-thread",
      terminalOutcome: "failed",
      completedCycles: 1,
      plannedStartTime: null
    });

    await expect(fs.readFile(path.join(result.archiveDir, "dispatch_plan.md"), "utf8"))
      .resolves.toContain("| ❌ | 1 | W-CATALOG | Catalog Sweep | CODEX-HIGH | PRE-FLIGHT |");

    const report = JSON.parse(await fs.readFile(result.jsonReportPath, "utf8"));
    expect(report.workers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        worker_id: "W-CATALOG",
        status: "failed"
      })
    ]));
  });
});

function buildConfig(dispatchPlanPath: string, reportBaseDir: string): SchedulerConfig {
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
    report_base_dir: reportBaseDir,
    catch_up_policy: "skip_missed"
  };
}
