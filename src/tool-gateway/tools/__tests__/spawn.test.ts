import { describe, expect, it, vi } from "vitest";

const mockSpawn = vi.fn();

vi.mock("../../../roles/agent-dispatcher/meridian-api-client", () => ({
  createMeridianApiClient: () => ({
    spawn: mockSpawn
  })
}));

import spawnTool, { parseModelIdWithEffort } from "../spawn";

describe("spawn tool", () => {
  it("returns thread metadata when the Meridian API returns a thread id", async () => {
    mockSpawn.mockResolvedValue({
      threadId: "thread-123",
      source: "codex"
    });

    const result = await spawnTool.execute({
      agent_type: "claude"
    });

    expect(mockSpawn).toHaveBeenCalledWith({
      agentType: "claude",
      mode: "pane_bridge",
      spawnDir: process.cwd(),
      modelId: undefined,
      autoApprove: undefined
    });
    expect(result).toEqual({
      ok: true,
      data: {
        thread_id: "thread-123",
        agent_type: "claude",
        mode: "pane_bridge",
        model_id: undefined
      }
    });
  });

  it("forwards model, workdir, and auto-approve overrides to the Meridian API", async () => {
    mockSpawn.mockResolvedValue({
      threadId: "thread-999",
      source: "codex"
    });

    const result = await spawnTool.execute({
      agent_type: "codex",
      mode: "pane_bridge",
      model_id: "gpt-5.4",
      spawn_dir: "/tmp/project",
      auto_approve: "false"
    });

    expect(mockSpawn).toHaveBeenCalledWith({
      agentType: "codex",
      mode: "pane_bridge",
      spawnDir: "/tmp/project",
      modelId: "gpt-5.4",
      autoApprove: false
    });
    expect(result).toEqual({
      ok: true,
      data: {
        thread_id: "thread-999",
        agent_type: "codex",
        mode: "pane_bridge",
        model_id: "gpt-5.4"
      }
    });
  });

  it("maps the API timeout to the worker contract", async () => {
    mockSpawn.mockRejectedValue(new Error("spawn failed: Meridian API unreachable at http://127.0.0.1:3000/: timed out"));

    const result = await spawnTool.execute({
      agent_type: "codex",
      mode: "pane_bridge"
    });

    expect(result).toEqual({
      ok: false,
      error: "Hub timeout after 60s"
    });
  });

  it("surfaces API-side spawn failures", async () => {
    mockSpawn.mockRejectedValue(new Error("spawn failed: Agent instance failed readiness check"));

    const result = await spawnTool.execute({
      agent_type: "claude",
      mode: "pane_bridge"
    });

    expect(result).toEqual({
      ok: false,
      error: "spawn failed: Agent instance failed readiness check"
    });
  });

  it("splits effort suffix from model_id and passes it with the model id", async () => {
    mockSpawn.mockResolvedValue({
      threadId: "thread-xh",
      source: "codex"
    });

    const result = await spawnTool.execute({
      agent_type: "codex",
      model_id: "gpt-5.4 xhigh"
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "gpt-5.4 xhigh"
      })
    );
    expect(result).toEqual({
      ok: true,
      data: {
        thread_id: "thread-xh",
        agent_type: "codex",
        mode: "pane_bridge",
        model_id: "gpt-5.4"
      }
    });
  });

  it("does not use HUB_SOCKET_PATH or raw Hub message construction", async () => {
    mockSpawn.mockResolvedValue({
      threadId: "thread-boundary",
      source: "codex"
    });

    await spawnTool.execute({ agent_type: "claude" });

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.not.objectContaining({
        intent: expect.any(String),
        actor_id: expect.any(String),
        payload: expect.any(Object)
      })
    );
  });
});

describe("parseModelIdWithEffort", () => {
  it("returns empty when no model_id is provided", () => {
    expect(parseModelIdWithEffort(undefined)).toEqual({});
  });

  it("returns model_id unchanged when no effort suffix", () => {
    expect(parseModelIdWithEffort("gpt-5.4")).toEqual({ modelId: "gpt-5.4" });
  });

  it("extracts known effort suffixes", () => {
    expect(parseModelIdWithEffort("gpt-5.4 low")).toEqual({ modelId: "gpt-5.4", effort: "low" });
    expect(parseModelIdWithEffort("gpt-5.4 medium")).toEqual({ modelId: "gpt-5.4", effort: "medium" });
    expect(parseModelIdWithEffort("gpt-5.4 high")).toEqual({ modelId: "gpt-5.4", effort: "high" });
    expect(parseModelIdWithEffort("gpt-5.4 xhigh")).toEqual({ modelId: "gpt-5.4", effort: "xhigh" });
  });

  it("is case-insensitive for effort suffix", () => {
    expect(parseModelIdWithEffort("gpt-5.4 HIGH")).toEqual({ modelId: "gpt-5.4", effort: "high" });
    expect(parseModelIdWithEffort("gpt-5.4 XHigh")).toEqual({ modelId: "gpt-5.4", effort: "xhigh" });
  });

  it("does not strip unknown suffixes", () => {
    expect(parseModelIdWithEffort("gpt-5.4 turbo")).toEqual({ modelId: "gpt-5.4 turbo" });
    expect(parseModelIdWithEffort("claude-sonnet-4-6")).toEqual({ modelId: "claude-sonnet-4-6" });
  });
});
