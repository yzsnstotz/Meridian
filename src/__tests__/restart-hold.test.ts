import { describe, expect, it, vi } from "vitest";

import { forcePauseAllDispatchersOnStartup } from "../index";
import type { AppState } from "../types";

function makeStateStore(initial: AppState) {
  let state: AppState = JSON.parse(JSON.stringify(initial));
  return {
    load: async () => JSON.parse(JSON.stringify(state)) as AppState,
    save: async (next: AppState) => {
      state = JSON.parse(JSON.stringify(next));
    },
    inspect: () => state
  };
}

const baseDispatcherConfig = {
  dispatcher_role_id: "x",
  agent_type: "codex" as const,
  mode: "bridge" as const,
  auto_approve: false,
  dispatch_plan_path: "/tmp/dispatch_plan.md",
  command_file_path: "/tmp/agent_dispatch_command.md",
  dispatch_repo_root: "/tmp",
  kill_policy: "always" as const,
  user_reply_channels: [{ channel: "telegram", chat_id: "telegram:test" }]
};

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
  debug: vi.fn()
} as unknown as typeof console;

describe("forcePauseAllDispatchersOnStartup", () => {
  it("flips active dispatchers to paused", async () => {
    const store = makeStateStore({
      roles: [
        { threadId: "agent-dispatcher-a", roleType: "agent-dispatcher", status: "active", config: { ...baseDispatcherConfig } },
        { threadId: "agent-dispatcher-b", roleType: "agent-dispatcher", status: "active", config: { ...baseDispatcherConfig } }
      ],
      promptStore: {}
    });

    await forcePauseAllDispatchersOnStartup(store as never, silentLog);

    const after = store.inspect();
    expect(after.roles[0]?.status).toBe("paused");
    expect(after.roles[1]?.status).toBe("paused");
  });

  it("does not modify terminal statuses (completed, failed, deactivated, terminated)", async () => {
    const store = makeStateStore({
      roles: [
        { threadId: "agent-dispatcher-c", roleType: "agent-dispatcher", status: "completed", config: { ...baseDispatcherConfig } },
        { threadId: "agent-dispatcher-d", roleType: "agent-dispatcher", status: "failed", config: { ...baseDispatcherConfig } },
        { threadId: "agent-dispatcher-e", roleType: "agent-dispatcher", status: "deactivated", config: { ...baseDispatcherConfig } },
        { threadId: "agent-dispatcher-f", roleType: "agent-dispatcher", status: "terminated", config: { ...baseDispatcherConfig } }
      ],
      promptStore: {}
    });

    await forcePauseAllDispatchersOnStartup(store as never, silentLog);

    const after = store.inspect();
    expect(after.roles.map((r) => r.status)).toEqual(["completed", "failed", "deactivated", "terminated"]);
  });

  it("leaves already-paused dispatchers paused (idempotent)", async () => {
    const store = makeStateStore({
      roles: [
        { threadId: "agent-dispatcher-g", roleType: "agent-dispatcher", status: "paused", config: { ...baseDispatcherConfig } }
      ],
      promptStore: {}
    });
    await forcePauseAllDispatchersOnStartup(store as never, silentLog);
    expect(store.inspect().roles[0]?.status).toBe("paused");
  });

  it("does not touch non-dispatcher roles (e.g. scheduler)", async () => {
    const store = makeStateStore({
      roles: [
        { threadId: "scheduler-h", roleType: "scheduler", status: "active", config: { dispatch_plan_path: "/tmp/a.md", dispatcher_thread_id: "x" } }
      ],
      promptStore: {}
    });
    await forcePauseAllDispatchersOnStartup(store as never, silentLog);
    expect(store.inspect().roles[0]?.status).toBe("active");
  });

  it("handles an empty state cleanly", async () => {
    const store = makeStateStore({ roles: [], promptStore: {} });
    await expect(forcePauseAllDispatchersOnStartup(store as never, silentLog)).resolves.toBeUndefined();
  });
});
