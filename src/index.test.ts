import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StateStore } from "./state-store";
import { resolveDispatchPlanPathsFromState } from "./index";
import { buildEmptyRunState } from "./roles/scheduler/scheduler-state-store";
import type { SchedulerConfig } from "./types";

const tempDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("resolveDispatchPlanPathsFromState", () => {
  it("includes terminal agent-dispatcher plans so watchdog can reconcile late worker outcomes", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-index-"));
    tempDirectories.add(directory);

    const failedPlanPath = path.join(directory, "failed", "dispatch_plan.md");
    const completedPlanPath = path.join(directory, "completed", "dispatch_plan.md");
    const stateStore = new StateStore(path.join(directory, "state.json"));

    await fs.mkdir(path.dirname(failedPlanPath), { recursive: true });
    await fs.mkdir(path.dirname(completedPlanPath), { recursive: true });
    await fs.writeFile(failedPlanPath, "# Failed Dispatch Plan\n", "utf8");
    await fs.writeFile(completedPlanPath, "# Completed Dispatch Plan\n", "utf8");
    await stateStore.save({
      roles: [
        {
          threadId: "dispatcher-failed",
          roleType: "agent-dispatcher",
          status: "failed",
          config: buildAgentDispatcherConfig(failedPlanPath)
        },
        {
          threadId: "dispatcher-completed",
          roleType: "agent-dispatcher",
          status: "completed",
          config: buildAgentDispatcherConfig(completedPlanPath)
        }
      ],
      promptStore: {}
    });

    await expect(resolveDispatchPlanPathsFromState(stateStore)).resolves.toEqual([
      failedPlanPath,
      completedPlanPath
    ]);
  });

  it("includes active scheduler runs for watchdog reconciliation", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-index-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    const schedulerStatePath = path.join(directory, "scheduler_state.json");
    const stateStore = new StateStore(path.join(directory, "state.json"));

    await fs.writeFile(dispatchPlanPath, "# Dispatch Plan\n", "utf8");
    await fs.writeFile(schedulerStatePath, `${JSON.stringify({
      ...buildEmptyRunState(),
      status: "active_run",
      current_run_id: "run-001"
    }, null, 2)}\n`, "utf8");
    await stateStore.save({
      roles: [
        {
          threadId: "scheduler-active",
          roleType: "scheduler",
          status: "active",
          config: buildSchedulerConfig(dispatchPlanPath)
        }
      ],
      promptStore: {}
    });

    await expect(resolveDispatchPlanPathsFromState(stateStore)).resolves.toEqual([dispatchPlanPath]);
  });
});

function buildAgentDispatcherConfig(dispatchPlanPath: string) {
  return {
    dispatch_plan_path: dispatchPlanPath,
    command_file_path: path.join(path.dirname(dispatchPlanPath), "dispatch_command.md"),
    dispatch_repo_root: path.dirname(dispatchPlanPath),
    docs_root: path.dirname(dispatchPlanPath),
    user_reply_channels: [{ channel: "web", chat_id: "web:ops" }],
    agent_type: "codex",
    mode: "bridge",
    kill_policy: "always",
    auto_approve: true
  };
}

function buildSchedulerConfig(dispatchPlanPath: string): SchedulerConfig {
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
    report_base_dir: path.join(directoryName(dispatchPlanPath), "reports"),
    catch_up_policy: "skip_missed"
  };
}

function directoryName(filePath: string): string {
  return path.dirname(filePath);
}
