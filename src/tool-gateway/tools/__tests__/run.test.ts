import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc-bridge", () => ({
  sendAndWait: vi.fn()
}));

import type { HubResult, HubResultStatus } from "../../../types";
import { sendAndWait } from "../../ipc-bridge";
import runTool from "../run";

const sendAndWaitMock = vi.mocked(sendAndWait);

afterEach(() => {
  vi.clearAllMocks();
});

describe("run tool", () => {
  it("waits indefinitely and maps successful Hub results to done", async () => {
    sendAndWaitMock.mockResolvedValue(buildHubResult("Worker completed", "success"));

    const result = await runTool.execute({
      thread_id: "thread-123",
      command: "/tmp/agent_dispatch_command.md",
      worker: "N-04"
    });

    expect(sendAndWaitMock).toHaveBeenCalledWith(
      {
        thread_id: "thread-123",
        actor_id: "service:meridian-tool",
        priority: 5,
        intent: "run",
        target: "thread-123",
        mode: "bridge",
        payload: {
          content: "/tmp/agent_dispatch_command.md",
          attachments: []
        }
      },
      0
    );
    expect(result).toEqual({
      ok: true,
      data: {
        worker: "N-04",
        status: "done",
        summary: "Worker completed"
      }
    });
  });

  it("maps Hub errors to failed worker status", async () => {
    sendAndWaitMock.mockResolvedValue(buildHubResult("Hub rejected run", "error"));

    const result = await runTool.execute({
      thread_id: "thread-456",
      command: "/tmp/agent_dispatch_command.md",
      worker: "N-04"
    });

    expect(result).toEqual({
      ok: false,
      error: "Hub rejected run",
      data: {
        worker: "N-04",
        status: "failed"
      }
    });
  });

  it("maps SIGINT cleanup failures to the interrupted contract", async () => {
    sendAndWaitMock.mockRejectedValue(new Error("Tool Gateway interrupted by SIGINT"));

    const result = await runTool.execute({
      thread_id: "thread-789",
      command: "/tmp/agent_dispatch_command.md",
      worker: "N-04"
    });

    expect(result).toEqual({
      ok: false,
      error: "interrupted",
      data: {
        worker: "N-04",
        status: "failed"
      }
    });
  });
});

function buildHubResult(content: string, status: HubResultStatus): HubResult {
  return {
    trace_id: "e2ba3ec7-e381-46f0-98d8-a6bb2e1b0d3f",
    thread_id: "dispatch-thread",
    source: "codex",
    status,
    content,
    attachments: [],
    timestamp: "2026-03-28T00:00:00.000Z"
  };
}
