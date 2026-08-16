import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SchedulerConfigSchema } from "../../../types";
import scheduleListTool from "../schedule-list";

describe("schedule-list tool", () => {
  let registryDir: string;

  beforeEach(async () => {
    registryDir = await fs.mkdtemp(path.join(os.tmpdir(), "schedule-list-"));
  });

  afterEach(async () => {
    await fs.rm(registryDir, { recursive: true, force: true });
  });

  it("requires registry_dir", async () => {
    const result = await scheduleListTool.execute({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("registry_dir is required");
  });

  it("returns an empty list when the directory is missing", async () => {
    const result = await scheduleListTool.execute({
      registry_dir: path.join(registryDir, "does-not-exist")
    });
    expect(result.ok).toBe(true);
    expect(result.data?.schedules).toEqual([]);
    expect(result.data?.count).toBe(0);
  });

  it("lists and validates each entry in the directory", async () => {
    const config = {
      dispatch_plan_path: "/abs/plan.md",
      command_file_path: "/abs/command.md",
      dispatch_repo_root: "/abs/repo",
      docs_root: "/abs/docs",
      user_reply_channels: [{ channel: "web", chat_id: "web:ops" }],
      agent_type: "codex",
      model_id: "gpt-5",
      mode: "bridge",
      kill_policy: "always",
      auto_approve: false,
      scheduler_mode: "cron",
      cron_expression: "0 0 * * *",
      timezone: "UTC",
      delay_between_cycles_seconds: 0,
      report_base_dir: "/abs/reports",
      catch_up_policy: "skip_missed"
    };
    await fs.writeFile(
      path.join(registryDir, "example.json"),
      JSON.stringify({ id: "example", description: "test", config })
    );

    const result = await scheduleListTool.execute({ registry_dir: registryDir });
    expect(result.ok).toBe(true);
    const schedules = result.data?.schedules as Array<{ id: string; config: unknown }>;
    expect(schedules).toHaveLength(1);
    expect(schedules[0].id).toBe("example");
    expect(SchedulerConfigSchema.safeParse(schedules[0].config).success).toBe(true);
  });

  it("returns an error for an entry with an invalid scheduler config", async () => {
    await fs.writeFile(
      path.join(registryDir, "bad.json"),
      JSON.stringify({ id: "bad", config: { scheduler_mode: "cron" } })
    );

    const result = await scheduleListTool.execute({ registry_dir: registryDir });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid scheduler config");
  });
});
