import { describe, expect, it, vi } from "vitest";

vi.mock("../../ipc-bridge", () => ({
  sendAndWait: vi.fn()
}));

import type { HubResult } from "../../../types";
import { sendAndWait } from "../../ipc-bridge";
import spawnTool, { parseModelIdWithEffort } from "../spawn";

const sendAndWaitMock = vi.mocked(sendAndWait);

describe("spawn tool", () => {
  it("returns thread metadata when the Hub embeds JSON content with trailing text", async () => {
    sendAndWaitMock.mockResolvedValue(
      buildHubResult('{"thread_id":"thread-123","status":"ready"}\n\nAttachments: none')
    );

    const result = await spawnTool.execute({
      agent_type: "claude"
    });

    expect(sendAndWaitMock).toHaveBeenCalledWith(
      {
        thread_id: "spawn",
        actor_id: "service:meridian-tool",
        priority: 5,
        intent: "spawn",
        target: "claude",
        mode: "pane_bridge",
        payload: {
          spawn_dir: process.cwd(),
          model_id: undefined,
          effort: undefined,
          auto_approve: undefined,
          content: "",
          attachments: []
        }
      },
      60_000
    );
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

  it("forwards model, workdir, and auto-approve overrides to Hub spawn", async () => {
    sendAndWaitMock.mockResolvedValue(buildHubResult('{"thread_id":"thread-999"}'));

    const result = await spawnTool.execute({
      agent_type: "codex",
      mode: "pane_bridge",
      model_id: "gpt-5.4",
      spawn_dir: "/tmp/project",
      auto_approve: "false"
    });

    expect(sendAndWaitMock).toHaveBeenCalledWith(
      {
        thread_id: "spawn",
        actor_id: "service:meridian-tool",
        priority: 5,
        intent: "spawn",
        target: "codex",
        mode: "pane_bridge",
        payload: {
          spawn_dir: "/tmp/project",
          model_id: "gpt-5.4",
          effort: undefined,
          auto_approve: false,
          content: "",
          attachments: []
        }
      },
      60_000
    );
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

  it("maps the gateway timeout to the worker contract", async () => {
    sendAndWaitMock.mockRejectedValue(new Error("Hub timeout after 60000ms"));

    const result = await spawnTool.execute({
      agent_type: "codex",
      mode: "pane_bridge"
    });

    expect(result).toEqual({
      ok: false,
      error: "Hub timeout after 60s"
    });
  });

  it("surfaces hub-side spawn failures instead of reporting a parse error", async () => {
    sendAndWaitMock.mockResolvedValue({
      ...buildHubResult("Hub rejected spawn"),
      status: "error",
      details_text: "Agent instance failed readiness check"
    });

    const result = await spawnTool.execute({
      agent_type: "claude",
      mode: "pane_bridge"
    });

    expect(result).toEqual({
      ok: false,
      error: "Agent instance failed readiness check"
    });
  });

  it("splits effort suffix from model_id and passes it separately in the payload", async () => {
    sendAndWaitMock.mockResolvedValue(buildHubResult('{"thread_id":"thread-xh"}'));

    const result = await spawnTool.execute({
      agent_type: "codex",
      model_id: "gpt-5.4 xhigh"
    });

    expect(sendAndWaitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          model_id: "gpt-5.4",
          effort: "xhigh"
        })
      }),
      60_000
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

  it("returns a parse failure when the Hub response does not contain spawn JSON", async () => {
    sendAndWaitMock.mockResolvedValue(buildHubResult("spawned thread-123"));

    const result = await spawnTool.execute({
      agent_type: "gemini"
    });

    expect(result).toEqual({
      ok: false,
      error: "Failed to parse spawn response"
    });
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

function buildHubResult(content: string): HubResult {
  return {
    trace_id: "e2ba3ec7-e381-46f0-98d8-a6bb2e1b0d3f",
    thread_id: "dispatch-thread",
    source: "codex",
    status: "success",
    content,
    attachments: [],
    timestamp: "2026-03-28T00:00:00.000Z"
  };
}
