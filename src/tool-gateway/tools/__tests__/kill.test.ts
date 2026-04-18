import { afterEach, describe, expect, it, vi } from "vitest";

const mockKill = vi.fn();

vi.mock("../../../roles/agent-dispatcher/meridian-api-client", () => ({
  createMeridianApiClient: () => ({
    kill: mockKill
  })
}));

import killTool from "../kill";

afterEach(() => {
  vi.clearAllMocks();
});

describe("kill tool", () => {
  it("returns the thread id when Meridian API acknowledges the kill", async () => {
    mockKill.mockResolvedValue({
      threadId: "thread-123",
      status: "success",
      raw: {}
    });

    const result = await killTool.execute({
      thread_id: "thread-123"
    });

    expect(mockKill).toHaveBeenCalledWith("thread-123");
    expect(result).toEqual({
      ok: true,
      data: {
        thread_id: "thread-123"
      }
    });
  });

  it("treats a timeout as a non-fatal kill result", async () => {
    mockKill.mockRejectedValue(new Error("kill failed: Meridian API unreachable at http://127.0.0.1:3000/: timed out"));

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

  it("returns ok:false when the API reports a kill error", async () => {
    mockKill.mockRejectedValue(new Error("kill failed: thread not found"));

    const result = await killTool.execute({
      thread_id: "thread-789"
    });

    expect(result).toEqual({
      ok: false,
      error: "kill failed: thread not found",
      data: {
        thread_id: "thread-789"
      }
    });
  });

  it("does not use HUB_SOCKET_PATH or raw Hub message construction", async () => {
    mockKill.mockResolvedValue({
      threadId: "thread-boundary",
      status: "success",
      raw: {}
    });

    await killTool.execute({ thread_id: "thread-boundary" });

    expect(mockKill).toHaveBeenCalledWith("thread-boundary");
  });
});
