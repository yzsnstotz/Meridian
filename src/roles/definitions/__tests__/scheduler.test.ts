import { describe, expect, it, vi } from "vitest";

import type { SchedulerConfig } from "../../../types";
import type { LaunchConfig, LaunchResult } from "../../agent-dispatcher/launcher";
import { SchedulerRole } from "../scheduler";

class MemoryStateStore {
  private state: unknown = null;
  async load(): Promise<null> {
    return this.state as null;
  }
  async save(state: unknown): Promise<void> {
    this.state = state;
  }
}

describe("SchedulerRole", () => {
  it("forwards SchedulerConfig.credential_id onto the LaunchConfig for the spawned child dispatcher", async () => {
    const launchDispatcher = vi.fn(async (): Promise<LaunchResult> => ({
      ok: true,
      threadId: "dispatcher-thread-sched"
    }));

    const role = new SchedulerRole(
      "scheduler-test",
      buildSchedulerConfig({ credential_id: "cred-sched" }),
      {
        stateStore: new MemoryStateStore() as never,
        launchDispatcher,
        meridianApi: {
          spawn: vi.fn(),
          run: vi.fn(),
          kill: vi.fn()
        } as never
      }
    );

    const launchChild = (
      role as unknown as { launchChildDispatcher: (config: SchedulerConfig) => Promise<string> }
    ).launchChildDispatcher.bind(role);

    const threadId = await launchChild(role.config);
    expect(threadId).toBe("dispatcher-thread-sched");
    expect(launchDispatcher).toHaveBeenCalledTimes(1);
    expect(launchDispatcher).toHaveBeenCalledWith(expect.objectContaining({
      credentialId: "cred-sched"
    } as Partial<LaunchConfig>));
  });

  it("omits credentialId from LaunchConfig when SchedulerConfig.credential_id is unset", async () => {
    const launchDispatcher = vi.fn(async (_config: LaunchConfig): Promise<LaunchResult> => ({
      ok: true,
      threadId: "dispatcher-thread-sched"
    }));

    const role = new SchedulerRole(
      "scheduler-test",
      buildSchedulerConfig(),
      {
        stateStore: new MemoryStateStore() as never,
        launchDispatcher,
        meridianApi: {
          spawn: vi.fn(),
          run: vi.fn(),
          kill: vi.fn()
        } as never
      }
    );

    const launchChild = (
      role as unknown as { launchChildDispatcher: (config: SchedulerConfig) => Promise<string> }
    ).launchChildDispatcher.bind(role);

    await launchChild(role.config);
    expect(launchDispatcher).toHaveBeenCalledTimes(1);
    const launchArgs = launchDispatcher.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(launchArgs).toBeDefined();
    expect(launchArgs.credentialId).toBeUndefined();
  });
});

function buildSchedulerConfig(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    dispatch_plan_path: "/tmp/scheduler-test/dispatch_plan.md",
    command_file_path: "/tmp/scheduler-test/agent_dispatch_command.md",
    dispatch_repo_root: "/tmp/scheduler-test",
    docs_root: "/tmp/scheduler-test",
    user_reply_channels: [{ channel: "web", chat_id: "web:ops" }],
    agent_type: "codex",
    mode: "pane_bridge",
    kill_policy: "always",
    auto_approve: true,
    scheduler_mode: "cron",
    cron_expression: "0 6 * * *",
    timezone: "Asia/Tokyo",
    delay_between_cycles_seconds: 0,
    report_base_dir: "/tmp/scheduler-test/reports",
    catch_up_policy: "skip_missed",
    ...overrides
  };
}
