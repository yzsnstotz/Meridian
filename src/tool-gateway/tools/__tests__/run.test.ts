import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc-bridge", () => ({
  sendAndWait: vi.fn()
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn()
}));

import type { HubResult, HubResultStatus, HubRunState } from "../../../types";
import { sendAndWait } from "../../ipc-bridge";
import runTool from "../run";
import { readFile } from "node:fs/promises";

const sendAndWaitMock = vi.mocked(sendAndWait);
const readFileMock = vi.mocked(readFile);

afterEach(() => {
  vi.clearAllMocks();
});

describe("run tool", () => {
  it("waits indefinitely and maps successful Hub results to done", async () => {
    sendAndWaitMock.mockResolvedValue(buildHubResult("Worker completed", "success"));
    readFileMock.mockResolvedValue("# command\n");

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
          content: expect.any(String),
          attachments: []
        }
      },
      0
    );
    expect(result).toEqual({
      ok: true,
      data: {
        worker: "N-04",
        thread_id: "thread-123",
        status: "done",
        run_state: "completed",
        summary: "Worker completed"
      }
    });
  });

  it("surfaces structured still_running results without flattening them to done", async () => {
    sendAndWaitMock.mockResolvedValue(buildHubResult("Worker still running", "partial", "still_running"));
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-234",
      command: "/tmp/agent_dispatch_command.md",
      worker: "N-05"
    });

    expect(result).toEqual({
      ok: true,
      data: {
        worker: "N-05",
        thread_id: "thread-234",
        status: "in_progress",
        run_state: "still_running",
        summary: "Worker still running"
      }
    });
  });

  it("surfaces structured timeout results without flattening them to failure", async () => {
    sendAndWaitMock.mockResolvedValue(buildHubResult("Wait window elapsed", "timeout", "timeout"));
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-345",
      command: "/tmp/agent_dispatch_command.md",
      worker: "N-06"
    });

    expect(result).toEqual({
      ok: true,
      data: {
        worker: "N-06",
        thread_id: "thread-345",
        status: "in_progress",
        run_state: "timeout",
        summary: "Wait window elapsed"
      }
    });
  });

  it("maps Hub errors to failed worker status", async () => {
    sendAndWaitMock.mockResolvedValue(buildHubResult("Hub rejected run", "error"));
    readFileMock.mockResolvedValue("# command\n");

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
        thread_id: "thread-456",
        status: "failed"
      }
    });
  });

  it("maps SIGINT cleanup failures to the interrupted contract", async () => {
    sendAndWaitMock.mockRejectedValue(new Error("Tool Gateway interrupted by SIGINT"));
    readFileMock.mockResolvedValue("# command\n");

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
        thread_id: "thread-789",
        status: "failed"
      }
    });
  });
});

function buildHubResult(content: string, status: HubResultStatus, runState?: HubRunState): HubResult {
  return {
    trace_id: "e2ba3ec7-e381-46f0-98d8-a6bb2e1b0d3f",
    thread_id: "dispatch-thread",
    source: "codex",
    status,
    run_state: runState,
    content,
    attachments: [],
    timestamp: "2026-03-28T00:00:00.000Z"
  };
}
