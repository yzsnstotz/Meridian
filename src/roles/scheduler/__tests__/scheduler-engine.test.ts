import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SchedulerEngine } from "../scheduler-engine";
import { SchedulerStateStore, buildEmptyRunState } from "../scheduler-state-store";
import type { SchedulerConfig } from "../../../types";

const tempDirectories = new Set<string>();

afterEach(async () => {
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
