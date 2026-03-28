import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc-bridge", () => ({
  sendAndWait: vi.fn()
}));

import type { HubResult } from "../../../types";
import { sendAndWait } from "../../ipc-bridge";
import killTool from "../kill";

const sendAndWaitMock = vi.mocked(sendAndWait);

afterEach(() => {
  vi.clearAllMocks();
});

describe("kill tool", () => {
  it("returns the thread id when Hub acknowledges the kill", async () => {
    sendAndWaitMock.mockResolvedValue(buildHubResult("killed", "success"));

    const result = await killTool.execute({
      thread_id: "thread-123"
    });

    expect(sendAndWaitMock).toHaveBeenCalledWith(
      {
        thread_id: "thread-123",
        actor_id: "service:meridian-tool",
        priority: 5,
        intent: "kill",
        target: "thread-123",
        mode: "bridge",
        payload: {
          content: "",
          attachments: []
        }
      },
      5_000
    );
    expect(result).toEqual({
      ok: true,
      data: {
        thread_id: "thread-123"
      }
    });
  });

  it("treats a gateway timeout as a non-fatal kill result", async () => {
    sendAndWaitMock.mockRejectedValue(new Error("Hub timeout after 5000ms"));

    const result = await killTool.execute({
      thread_id: "thread-456"
    });

    expect(result).toEqual({
      ok: true,
      data: {
        thread_id: "thread-456"
      }
    });
  });

  it("returns ok:false when Hub reports a kill error", async () => {
    sendAndWaitMock.mockResolvedValue(buildHubResult("thread not found", "error"));

    const result = await killTool.execute({
      thread_id: "thread-789"
    });

    expect(result).toEqual({
      ok: false,
      error: "thread not found",
      data: {
        thread_id: "thread-789"
      }
    });
  });
});

function buildHubResult(content: string, status: HubResult["status"]): HubResult {
  return {
    trace_id: "e2ba3ec7-e381-46f0-98d8-a6bb2e1b0d3f",
    thread_id: "dispatcher-1",
    source: "codex",
    status,
    content,
    attachments: [],
    timestamp: "2026-03-28T00:00:00.000Z"
  };
}
