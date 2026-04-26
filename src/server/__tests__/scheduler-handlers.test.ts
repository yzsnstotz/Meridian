import path from "node:path";

import { describe, expect, it } from "vitest";

import { computeSchedulerNextRunPreview } from "../scheduler-handlers";
import { buildEmptyRunState } from "../../roles/scheduler/scheduler-state-store";
import type { SchedulerConfig } from "../../types";

describe("computeSchedulerNextRunPreview", () => {
  it("suppresses cron previews after max cycles complete", () => {
    const preview = computeSchedulerNextRunPreview(
      buildConfig(),
      {
        ...buildEmptyRunState(),
        status: "completed_max_cycles",
        completed_cycles: 2,
        last_run_outcome: "completed"
      },
      new Date("2026-04-26T07:00:00.000Z")
    );

    expect(preview).toBeNull();
  });

  it("suppresses cron previews while a run is active", () => {
    const preview = computeSchedulerNextRunPreview(
      buildConfig(),
      {
        ...buildEmptyRunState(),
        status: "active_run",
        current_run_id: "run-active"
      },
      new Date("2026-04-26T07:00:00.000Z")
    );

    expect(preview).toBeNull();
  });

  it("keeps cron previews for schedulers that can accept a future run", () => {
    const preview = computeSchedulerNextRunPreview(
      buildConfig(),
      {
        ...buildEmptyRunState(),
        status: "idle"
      },
      new Date("2026-04-26T07:00:00.000Z")
    );

    expect(preview).toBeTruthy();
  });
});

function buildConfig(): SchedulerConfig {
  return {
    dispatch_plan_path: path.join("/tmp", "dispatch_plan.md"),
    command_file_path: path.join("/tmp", "agent_dispatch_command.md"),
    dispatch_repo_root: "/tmp",
    docs_root: "/tmp",
    user_reply_channels: [{ channel: "web", chat_id: "web:ops" }],
    agent_type: "codex",
    mode: "pane_bridge",
    kill_policy: "always",
    auto_approve: true,
    scheduler_mode: "cron",
    cron_expression: "0 6 * * *",
    timezone: "Asia/Tokyo",
    delay_between_cycles_seconds: 0,
    report_base_dir: path.join("/tmp", "reports"),
    catch_up_policy: "skip_missed"
  };
}
