import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { detectCycleCompletion } from "../cycle-manager";
import type { SchedulerConfig } from "../../../types";

const tempDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("detectCycleCompletion", () => {
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
