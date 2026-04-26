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
