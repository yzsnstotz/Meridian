import { describe, expect, it, vi } from "vitest";

import { RoleTypeSchema, type AgentInstance, type HubResult, type RoleType } from "../../types";
import type { BaseRole, Logger, RoleContext } from "../base-role";
import { RoleRegistry } from "../role-registry";
import { RoleRunner } from "../role-runner";

const instances: AgentInstance[] = [
  {
    thread_id: "claude_01",
    agent_type: "claude",
    model_id: "opus",
    mode: "bridge",
    socket_path: "/tmp/claude.sock",
    working_dir: "/tmp",
    pid: 123,
    status: "idle",
    created_at: "2026-03-19T00:00:00.000Z",
    restart_safe: true,
    auto_approve: false
  }
];

const sampleResult: HubResult = {
  trace_id: "123e4567-e89b-12d3-a456-426614174000",
  thread_id: "dispatcher-1",
  source: "claude",
  status: "success",
  content: "done",
  attachments: [],
  timestamp: "2026-03-19T00:00:00.000Z"
};

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function createMockRole(
  threadId = "dispatcher-1",
  config: unknown = { enabled: true },
  roleType: RoleType = "dispatcher"
) {
  let capturedContext: RoleContext | undefined;

  const role = {
    roleType,
    threadId,
    config,
    onActivate: vi.fn(async (ctx: RoleContext) => {
      capturedContext = ctx;
    }),
    onDeactivate: vi.fn(async () => {}),
    onInboundResult: vi.fn(async () => {}),
    onStatusChange: vi.fn(async () => {})
  } satisfies BaseRole;

  return {
    role,
    getContext: () => capturedContext
  };
}

describe("RoleRunner", () => {
  it("accepts the agent-dispatcher role type", () => {
    expect(RoleTypeSchema.parse("dispatcher")).toBe("dispatcher");
    expect(RoleTypeSchema.parse("agent-dispatcher")).toBe("agent-dispatcher");
  });

  it("activates a role with the shared context", async () => {
    const logger = createLogger();
    const sendToHub = vi.fn(async () => {});
    const { role, getContext } = createMockRole();
    const runner = new RoleRunner({
      sendToHub,
      listInstances: () => instances,
      log: logger
    });

    await runner.activate(role);

    expect(role.onActivate).toHaveBeenCalledTimes(1);
    const context = getContext();
    expect(context).toBeDefined();
    expect(context?.log).toBe(logger);
    expect(await context?.listInstances()).toEqual(instances);

    await context?.sendToHub({ intent: "run" });
    expect(sendToHub).toHaveBeenCalledWith({ intent: "run" });
  });

  it("dispatches inbound results to the matching role by thread_id", async () => {
    const { role } = createMockRole();
    const runner = new RoleRunner({
      sendToHub: vi.fn(async () => {})
    });

    await runner.activate(role);
    await runner.dispatch(sampleResult);

    expect(role.onInboundResult).toHaveBeenCalledTimes(1);
    expect(role.onInboundResult).toHaveBeenCalledWith(sampleResult);
  });

  it("forwards pause and resume lifecycle signals to the active role", async () => {
    const { role } = createMockRole("agent-dispatcher-1", {}, "agent-dispatcher");
    const runner = new RoleRunner({
      sendToHub: vi.fn(async () => {})
    });

    await runner.activate(role);

    await expect(runner.pauseRole(role.threadId)).resolves.toBe(true);
    await expect(runner.resumeRole(role.threadId)).resolves.toBe(true);

    expect(role.onStatusChange).toHaveBeenNthCalledWith(1, "agent-dispatcher-1", "paused");
    expect(role.onStatusChange).toHaveBeenNthCalledWith(2, "agent-dispatcher-1", "active");
    expect(runner.getRole(role.threadId)).toBe(role);
  });

  it("returns false when pausing or resuming an inactive role", async () => {
    const runner = new RoleRunner({
      sendToHub: vi.fn(async () => {})
    });

    await expect(runner.pauseRole("missing-role")).resolves.toBe(false);
    await expect(runner.resumeRole("missing-role")).resolves.toBe(false);
    expect(runner.getRole("missing-role")).toBeNull();
  });

  it("silently ignores inbound results for unknown thread_id", async () => {
    const logger = createLogger();
    const { role } = createMockRole();
    const runner = new RoleRunner({
      sendToHub: vi.fn(async () => {}),
      log: logger
    });

    await runner.activate(role);
    await runner.dispatch({
      ...sampleResult,
      thread_id: "other-thread"
    });

    expect(role.onInboundResult).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });

  it("falls back to trace_id correlation for dispatcher results routed to an agent thread", async () => {
    const traceId = "123e4567-e89b-12d3-a456-426614174000";
    const { role } = createMockRole("dispatcher-trace", {
      tasks: [
        {
          task_id: "task-a",
          result_trace_id: traceId
        }
      ]
    }, "agent-dispatcher");
    const runner = new RoleRunner({
      sendToHub: vi.fn(async () => {})
    });

    await runner.activate(role);
    await runner.dispatch({
      ...sampleResult,
      thread_id: "codex_01",
      trace_id: traceId
    });

    expect(role.onInboundResult).toHaveBeenCalledTimes(1);
    expect(role.onInboundResult).toHaveBeenCalledWith({
      ...sampleResult,
      thread_id: "codex_01",
      trace_id: traceId
    });
  });

  it("falls back to trace_id correlation for agent-dispatcher results routed to an agent thread", async () => {
    const traceId = "123e4567-e89b-12d3-a456-426614174001";
    const { role } = createMockRole(
      "agent-dispatcher-trace",
      {
        tasks: [
          {
            task_id: "task-a",
            result_trace_id: traceId
          }
        ]
      },
      "agent-dispatcher"
    );
    const runner = new RoleRunner({
      sendToHub: vi.fn(async () => {})
    });

    await runner.activate(role);
    await runner.dispatch({
      ...sampleResult,
      thread_id: "codex_02",
      trace_id: traceId
    });

    expect(role.onInboundResult).toHaveBeenCalledTimes(1);
    expect(role.onInboundResult).toHaveBeenCalledWith({
      ...sampleResult,
      thread_id: "codex_02",
      trace_id: traceId
    });
  });

  it("deactivates a role and unregisters it", async () => {
    const logger = createLogger();
    const { role } = createMockRole();
    const runner = new RoleRunner({
      sendToHub: vi.fn(async () => {}),
      log: logger
    });

    await runner.activate(role);
    await runner.deactivate(role.threadId);
    await runner.dispatch(sampleResult);

    expect(role.onDeactivate).toHaveBeenCalledTimes(1);
    expect(role.onInboundResult).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });

  it("lists the currently active roles", async () => {
    const first = createMockRole("dispatcher-1").role;
    const second = createMockRole("agent-dispatcher-1", {}, "agent-dispatcher").role;
    const runner = new RoleRunner({
      sendToHub: vi.fn(async () => {})
    });

    await runner.activate(first);
    await runner.activate(second);
    expect(runner.listRoles()).toEqual([first, second]);

    await runner.deactivate(first.threadId);
    expect(runner.listRoles()).toEqual([second]);
  });
});

describe("RoleRegistry", () => {
  it("creates registered role instances", async () => {
    const registry = new RoleRegistry();
    const { role } = createMockRole("dispatcher-2");

    registry.register("dispatcher", () => role);

    const created = registry.create("dispatcher", "dispatcher-2", { enabled: true });

    expect(created).toBe(role);
    expect(created.threadId).toBe("dispatcher-2");
    await expect(created.onDeactivate()).resolves.toBeUndefined();
  });
});
