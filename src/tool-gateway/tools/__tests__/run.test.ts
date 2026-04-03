import { afterEach, describe, expect, it, vi } from "vitest";

const { lifecycleStoreConstructor, reconcileMock } = vi.hoisted(() => ({
  reconcileMock: vi.fn().mockResolvedValue({
    changed: [],
    unchanged: []
  }),
  lifecycleStoreConstructor: vi.fn().mockImplementation((filePath: string) => {
    const workers: Record<string, Record<string, unknown>> = {};

    return {
      filePath,
      recordWorkerStart: vi.fn((workerId: string, threadId: string, traceId: string, expectedOutputs: string[]) => {
        workers[workerId] = {
          thread_id: threadId,
          trace_id: traceId,
          status: "running",
          expected_outputs: [...expectedOutputs],
          hub_result: null
        };
      }),
      recordWorkerResult: vi.fn((workerId: string, hubResult: { status: string; run_state?: string }) => {
        const worker = workers[workerId];
        if (!worker) {
          throw new Error(`Worker not found: ${workerId}`);
        }

        workers[workerId] = {
          ...worker,
          status: hubResult.status === "error"
            ? "failed"
            : hubResult.status === "success" && (!hubResult.run_state || hubResult.run_state === "completed")
              ? "completed"
              : "running",
          hub_result: hubResult
        };
      }),
      load: vi.fn(() => ({
        workers: structuredClone(workers)
      }))
    };
  })
}));

vi.mock("../../ipc-bridge", () => ({
  sendAndWait: vi.fn()
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn()
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn()
}));

vi.mock("../../../roles/agent-dispatcher/lifecycle-store", () => ({
  LifecycleStore: lifecycleStoreConstructor
}));

vi.mock("../../../roles/agent-dispatcher/reconciler", () => ({
  reconcile: reconcileMock
}));

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { HubResult, HubResultStatus, HubRunState } from "../../../types";
import { sendAndWait } from "../../ipc-bridge";
import runTool from "../run";

type MockLifecycleStore = {
  filePath: string;
  recordWorkerStart: ReturnType<typeof vi.fn>;
  recordWorkerResult: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
};

const randomUUIDMock = vi.mocked(randomUUID);
const readFileMock = vi.mocked(readFile);
const sendAndWaitMock = vi.mocked(sendAndWait);

afterEach(() => {
  vi.clearAllMocks();
  randomUUIDMock.mockReturnValue("11111111-1111-4111-8111-111111111111");
});

describe("run tool", () => {
  it("records worker start before sendAndWait and records the returned Hub result after success", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    sendAndWaitMock.mockResolvedValue(hubResult);
    readFileMock.mockResolvedValue("# command\n");
    randomUUIDMock.mockReturnValue("11111111-1111-4111-8111-111111111111");

    const result = await runTool.execute({
      thread_id: "thread-123",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-04"
    });

    const lifecycleStore = getLifecycleStore();

    expect(lifecycleStoreConstructor).toHaveBeenCalledWith("/tmp/dispatch/dispatch_threads.json");
    expect(lifecycleStore.recordWorkerStart).toHaveBeenCalledWith(
      "N-04",
      "thread-123",
      "11111111-1111-4111-8111-111111111111",
      ["/tmp/dispatch/dev_history/N-04_report.md"]
    );
    expect(lifecycleStore.recordWorkerStart.mock.invocationCallOrder[0]).toBeLessThan(
      sendAndWaitMock.mock.invocationCallOrder[0]
    );
    expect(sendAndWaitMock).toHaveBeenCalledWith(
      {
        trace_id: "11111111-1111-4111-8111-111111111111",
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
    expect(lifecycleStore.recordWorkerResult).toHaveBeenCalledWith("N-04", hubResult);
    expect(sendAndWaitMock.mock.invocationCallOrder[0]).toBeLessThan(
      lifecycleStore.recordWorkerResult.mock.invocationCallOrder[0]
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
      command: "/tmp/dispatch/agent_dispatch_command.md",
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

  it("schedules reconciliation after recording the Hub result without blocking the response", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    sendAndWaitMock.mockResolvedValue(hubResult);
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-654",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "R-04"
    });

    const lifecycleStore = getLifecycleStore();

    expect(result).toEqual({
      ok: true,
      data: {
        worker: "R-04",
        thread_id: "thread-654",
        status: "done",
        run_state: "completed",
        summary: "Worker completed"
      }
    });
    expect(reconcileMock).not.toHaveBeenCalled();

    await waitForImmediate();

    expect(reconcileMock).toHaveBeenCalledWith(
      lifecycleStore,
      expect.objectContaining({
        serviceId: "service:meridian-roles",
        sendRequest: expect.any(Function)
      })
    );
    expect(lifecycleStore.recordWorkerResult.mock.invocationCallOrder[0]).toBeLessThan(
      reconcileMock.mock.invocationCallOrder[0]
    );
  });

  it("surfaces structured timeout results without flattening them to failure", async () => {
    sendAndWaitMock.mockResolvedValue(buildHubResult("Wait window elapsed", "timeout", "timeout"));
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-345",
      command: "/tmp/dispatch/agent_dispatch_command.md",
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

  it("swallows reconciliation failures after the run result is returned", async () => {
    const consoleWarnMock = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    reconcileMock.mockRejectedValueOnce(new Error("Hub unavailable"));
    sendAndWaitMock.mockResolvedValue(buildHubResult("Worker completed", "success"));
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-777",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "R-05"
    });

    expect(result).toEqual({
      ok: true,
      data: {
        worker: "R-05",
        thread_id: "thread-777",
        status: "done",
        run_state: "completed",
        summary: "Worker completed"
      }
    });

    await waitForImmediate();

    expect(consoleWarnMock).toHaveBeenCalledWith("run tool reconciliation failed", {
      filePath: "/tmp/dispatch/dispatch_threads.json",
      error: "Hub unavailable"
    });
  });

  it("maps Hub errors to failed worker status", async () => {
    sendAndWaitMock.mockResolvedValue(buildHubResult("Hub rejected run", "error"));
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-456",
      command: "/tmp/dispatch/agent_dispatch_command.md",
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

  it("leaves the worker in running when sendAndWait throws", async () => {
    const consoleErrorMock = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sendAndWaitMock.mockRejectedValue(new Error("Hub timeout after 5000ms"));
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-789",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-04"
    });

    const lifecycleStore = getLifecycleStore();

    expect(lifecycleStore.recordWorkerResult).not.toHaveBeenCalled();
    expect(lifecycleStore.load().workers["N-04"]).toMatchObject({
      thread_id: "thread-789",
      trace_id: "11111111-1111-4111-8111-111111111111",
      status: "running",
      expected_outputs: ["/tmp/dispatch/dev_history/N-04_report.md"],
      hub_result: null
    });
    expect(consoleErrorMock).toHaveBeenCalledWith("run tool execution failed", {
      worker: "N-04",
      threadId: "thread-789",
      error: "Hub timeout after 5000ms"
    });
    expect(result).toEqual({
      ok: false,
      error: "Hub timeout after 5000ms",
      data: {
        worker: "N-04",
        thread_id: "thread-789",
        status: "failed"
      }
    });
  });

  it("maps SIGINT cleanup failures to the interrupted contract", async () => {
    const consoleErrorMock = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sendAndWaitMock.mockRejectedValue(new Error("Tool Gateway interrupted by SIGINT"));
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-999",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-07"
    });

    const lifecycleStore = getLifecycleStore();

    expect(lifecycleStore.recordWorkerResult).not.toHaveBeenCalled();
    expect(lifecycleStore.load().workers["N-07"]).toMatchObject({
      status: "running"
    });
    expect(consoleErrorMock).toHaveBeenCalledWith("run tool execution failed", {
      worker: "N-07",
      threadId: "thread-999",
      error: "Tool Gateway interrupted by SIGINT"
    });
    expect(result).toEqual({
      ok: false,
      error: "interrupted",
      data: {
        worker: "N-07",
        thread_id: "thread-999",
        status: "failed"
      }
    });
  });
});

function getLifecycleStore(): MockLifecycleStore {
  const store = lifecycleStoreConstructor.mock.results.at(-1)?.value as MockLifecycleStore | undefined;
  if (!store) {
    throw new Error("LifecycleStore was not constructed");
  }

  return store;
}

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

async function waitForImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}
