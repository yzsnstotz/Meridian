import { describe, expect, it, vi } from "vitest";

vi.mock("../../ipc-bridge", () => ({
  sendAndWait: vi.fn()
}));

import type { HubResult } from "../../../types";
import { sendAndWait } from "../../ipc-bridge";
import spawnTool from "../spawn";

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
        mode: "bridge",
        payload: {
          spawn_dir: process.cwd(),
          model_id: undefined,
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
        mode: "bridge",
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
