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

        const expectedOutputs = Array.isArray(worker.expected_outputs)
          ? worker.expected_outputs as string[]
          : [];
        const requiresOutputVerification = expectedOutputs.some((filePath) => !filePath.includes("/dev_history/"));
        workers[workerId] = {
          ...worker,
          status: hubResult.status === "error"
            ? "failed"
            : hubResult.status === "success"
              && (!hubResult.run_state || hubResult.run_state === "completed")
              && !requiresOutputVerification
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
  it("derives expected outputs from dispatch-plan notes before sendAndWait", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    sendAndWaitMock.mockResolvedValue(hubResult);
    mockCommandAndPlanReads("/tmp/dispatch/agent_dispatch_command.md", [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| 🔄 | 4 | N-04 | Ship outputs | CODEX | N-03 | Read `input.txt`, write `final.txt`, and append a line to `audit.txt`. |"
    ].join("\n"));
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
      ["/tmp/dispatch/final.txt", "/tmp/dispatch/audit.txt"],
      expect.any(String)
    );
    expect(lifecycleStore.recordWorkerStart.mock.invocationCallOrder[0]).toBeLessThan(
      sendAndWaitMock.mock.invocationCallOrder[0]
    );
    const sentPayload = sendAndWaitMock.mock.calls[0]?.[0] as { payload: { content: string } };
    expect(sentPayload.payload.content).toContain("You are **CODEX**");
    expect(sentPayload.payload.content).toContain("worker **N-04**");
    expect(sentPayload.payload.content).toContain("**N-04**: Ship outputs");
    expect(sentPayload.payload.content).toContain("/tmp/dispatch/agent_dispatch_command.md");
    expect(sentPayload.payload.content).not.toContain("# command");
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

  it("keeps successful workers running until reconciliation verifies real outputs", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    sendAndWaitMock.mockResolvedValue(hubResult);
    mockCommandAndPlanReads("/tmp/dispatch/agent_dispatch_command.md", [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| 🔄 | 4 | N-04 | Ship outputs | CODEX | N-03 | Read `input.txt`, write `final.txt`, and append a line to `audit.txt`. |"
    ].join("\n"));

    const result = await runTool.execute({
      thread_id: "thread-123",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-04"
    });

    const lifecycleStore = getLifecycleStore();

    expect(lifecycleStore.load().workers["N-04"]).toMatchObject({
      status: "running",
      expected_outputs: ["/tmp/dispatch/final.txt", "/tmp/dispatch/audit.txt"],
      hub_result: hubResult
    });
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

  it("derives the completion report path from the dispatch command template", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    sendAndWaitMock.mockResolvedValue(hubResult);
    readFileMock.mockImplementation(async (filePath) => {
      if (filePath === "/tmp/dispatch/agent_dispatch_command.md") {
        return [
          "# Agent Dispatch Command",
          "",
          "Write your completion report to:",
          "```",
          "/tmp/dispatch/dev_history/v1_round/[WORKER_ID]_report.md",
          "```"
        ].join("\n");
      }

      if (filePath === "/tmp/dispatch/dispatch_plan.md") {
        return [
          "# Dispatch Plan",
          "",
          "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
          "|--------|-------|--------|------|-------|------------|-------|",
          "| 🔄 | 4 | N-04 | Resume worker | CODEX | R-03 | No non-report outputs required. |"
        ].join("\n");
      }

      throw new Error(`Unexpected readFile path: ${String(filePath)}`);
    });

    await runTool.execute({
      thread_id: "thread-234",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-04"
    });

    const lifecycleStore = getLifecycleStore();
    expect(lifecycleStore.recordWorkerStart).toHaveBeenCalledWith(
      "N-04",
      "thread-234",
      "11111111-1111-4111-8111-111111111111",
      ["/tmp/dispatch/dev_history/v1_round/N-04_report.md"],
      expect.any(String)
    );
  });

  it("keeps the dispatcher wrapper in control-flow mode instead of implementation mode", async () => {
    const hubResult = buildHubResult("Dispatcher paused", "success");
    sendAndWaitMock.mockResolvedValue(hubResult);
    mockCommandAndPlanReads("/tmp/dispatch/agent_dispatch_command.md", [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| 🔄 | Ω+2 | DISPATCHER | Drive the next eligible worker | CODEX | DELTA-CHECK | Controller row. |"
    ].join("\n"));

    await runTool.execute({
      thread_id: "dispatcher-thread",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "DISPATCHER"
    });

    const lifecycleStore = getLifecycleStore();
    expect(lifecycleStore.recordWorkerStart).toHaveBeenCalledWith(
      "DISPATCHER",
      "dispatcher-thread",
      "11111111-1111-4111-8111-111111111111",
      [],
      expect.any(String)
    );

    const sentPayload = sendAndWaitMock.mock.calls[0]?.[0] as { payload: { content: string } };
    expect(sentPayload.payload.content).toContain("You are the dispatcher controller.");
    expect(sentPayload.payload.content).toContain("Treat any local Meridian tool bootstrap failure");
    expect(sentPayload.payload.content).toContain("create extra repo artifacts");
    expect(sentPayload.payload.content).not.toContain("completion report): attempt to write the report");
    expect(sentPayload.payload.content).not.toContain("follow normally (read specs, implement, test, git commit, push)");
    expect(sentPayload.payload.content).not.toContain("git commit, push");
  });

  it("prefers the DELTA-CHECK-specific report path over the generic completion template", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    sendAndWaitMock.mockResolvedValue(hubResult);
    readFileMock.mockImplementation(async (filePath) => {
      if (filePath === "/tmp/dispatch/agent_dispatch_command.md") {
        return [
          "# Agent Dispatch Command",
          "",
          "Write your completion report to:",
          "```",
          "/tmp/dispatch/dev_history/v1_round/[WORKER_ID]_report.md",
          "```",
          "",
          "Write to: `/tmp/dispatch/dev_history/v1_round/delta_check_report.md`"
        ].join("\n");
      }

      if (filePath === "/tmp/dispatch/dispatch_plan.md") {
        return [
          "# Dispatch Plan",
          "",
          "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
          "|--------|-------|--------|------|-------|------------|-------|",
          "| 🔄 | Ω | DELTA-CHECK | Delta Check | CODEX | N-04 | No non-report outputs required. |"
        ].join("\n");
      }

      throw new Error(`Unexpected readFile path: ${String(filePath)}`);
    });

    await runTool.execute({
      thread_id: "thread-delta",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "DELTA-CHECK"
    });

    const lifecycleStore = getLifecycleStore();
    expect(lifecycleStore.recordWorkerStart).toHaveBeenCalledWith(
      "DELTA-CHECK",
      "thread-delta",
      "11111111-1111-4111-8111-111111111111",
      ["/tmp/dispatch/dev_history/v1_round/delta_check_report.md"],
      expect.any(String)
    );
  });

  it("resolves dispatch-plan-relative delta repair artifacts under the plan directory", async () => {
    const planDirectory = "/Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration";
    const hubResult = buildHubResult("Worker completed", "success");
    sendAndWaitMock.mockResolvedValue(hubResult);
    readFileMock.mockImplementation(async (filePath) => {
      if (filePath === `${planDirectory}/dispatch_plan.md`) {
        return [
          "# Dispatch Plan",
          "",
          "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
          "|--------|-------|--------|------|-------|------------|-------|",
          "| ⚠️ ABANDONED | Ω+2 | R-08 | Delta Artifact Repair | CODEX | PR-REVIEW | Write the missing `dev_history/v1_round/delta_check_report.md` and reconcile DELTA-CHECK evidence. |"
        ].join("\n");
      }

      throw new Error(`Unexpected readFile path: ${String(filePath)}`);
    });

    await runTool.execute({
      thread_id: "thread-r08",
      command: `${planDirectory}/agent_dispatch_command.md`,
      worker: "R-08"
    });

    const lifecycleStore = getLifecycleStore();
    expect(lifecycleStore.recordWorkerStart).toHaveBeenCalledWith(
      "R-08",
      "thread-r08",
      "11111111-1111-4111-8111-111111111111",
      ["/Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dev_history/v1_round/delta_check_report.md"],
      expect.any(String)
    );
  });

  it("keeps a special-node report path when generic Step 5b is dispatch-plan-relative", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    sendAndWaitMock.mockResolvedValue(hubResult);
    readFileMock.mockImplementation(async (filePath) => {
      if (filePath === "/tmp/repo/docs/branch/feat/agent_dispatch_command.md") {
        return [
          "# Agent Dispatch Command",
          "",
          "Write your completion report to:",
          "```",
          "dev_history/v1_round/[WORKER_ID]_report.md",
          "```",
          "",
          "Write to: `dev_history/v1_round/delta_check_report.md`"
        ].join("\n");
      }

      if (filePath === "/tmp/repo/docs/branch/feat/dispatch_plan.md") {
        return [
          "# Dispatch Plan",
          "",
          "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
          "|--------|-------|--------|------|-------|------------|-------|",
          "| 🔄 | Ω | DELTA-CHECK | Delta Check | CODEX | N-04 | No non-report outputs required. |"
        ].join("\n");
      }

      throw new Error(`Unexpected readFile path: ${String(filePath)}`);
    });

    await runTool.execute({
      thread_id: "thread-delta",
      command: "/tmp/repo/docs/branch/feat/agent_dispatch_command.md",
      worker: "DELTA-CHECK"
    });

    const lifecycleStore = getLifecycleStore();
    expect(lifecycleStore.recordWorkerStart).toHaveBeenCalledWith(
      "DELTA-CHECK",
      "thread-delta",
      "11111111-1111-4111-8111-111111111111",
      ["/tmp/repo/docs/branch/feat/dev_history/v1_round/delta_check_report.md"],
      expect.any(String)
    );
  });

  it("injects prior reply and report context when a worker is redone", async () => {
    lifecycleStoreConstructor.mockImplementationOnce((filePath: string) => {
      const workers: Record<string, Record<string, unknown>> = {
        "N-04": {
          thread_id: "thread-prev",
          trace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          started_at: "2026-03-27T23:50:00.000Z",
          last_seen_at: "2026-03-27T23:57:00.000Z",
          status: "pending",
          expected_outputs: ["/tmp/dispatch/dev_history/v1_round/N-04_report.md"],
          hub_result: {
            trace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            thread_id: "thread-prev",
            source: "codex",
            status: "success",
            run_state: "completed",
            content: "Earlier pass finished.",
            summary_text: "Earlier pass finished.",
            details_text: "Your message:\nPrevious run\n\nAgent reply:\nWatch the same GUI drift again.",
            attachments: [],
            timestamp: "2026-03-27T23:57:00.000Z"
          }
        }
      };

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
            status: hubResult.status === "error" ? "failed" : "completed",
            hub_result: hubResult
          };
        }),
        load: vi.fn(() => ({
          workers: structuredClone(workers)
        }))
      };
    });

    sendAndWaitMock.mockResolvedValue(buildHubResult("Worker completed", "success"));
    readFileMock.mockImplementation(async (filePath) => {
      if (filePath === "/tmp/dispatch/agent_dispatch_command.md") {
        return [
          "# Agent Dispatch Command",
          "",
          "Write your completion report to:",
          "```",
          "/tmp/dispatch/dev_history/v1_round/[WORKER_ID]_report.md",
          "```"
        ].join("\n");
      }

      if (filePath === "/tmp/dispatch/dispatch_plan.md") {
        return [
          "# Dispatch Plan",
          "",
          "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
          "|--------|-------|--------|------|-------|------------|-------|",
          "| ⬜ | 4 | N-04 | Re-run GUI audit | CODEX | N-03 | Use prior findings as context. |"
        ].join("\n");
      }

      if (filePath === "/tmp/dispatch/dev_history/v1_round/N-04_report.md") {
        return "# Earlier Report\n- The last pass missed the default checkbox behavior.";
      }

      throw new Error(`Unexpected readFile path: ${String(filePath)}`);
    });

    await runTool.execute({
      thread_id: "thread-123",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-04"
    });

    const sentPayload = sendAndWaitMock.mock.calls[0]?.[0] as { payload: { content: string } };
    expect(sentPayload.payload.content).toContain("# Previous Attempt Context");
    expect(sentPayload.payload.content).toContain("Watch the same GUI drift again.");
    expect(sentPayload.payload.content).toContain("# Earlier Report");
    expect(sentPayload.payload.content).toContain("avoid repeating the same mistake");
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

  it("awaits reconciliation before returning terminal results", async () => {
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

  it("kills terminal worker threads when kill_policy is always", async () => {
    sendAndWaitMock
      .mockResolvedValueOnce(buildHubResult("Worker completed", "success"))
      .mockResolvedValueOnce(buildHubResult("", "success"));
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-222",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "R-06",
      kill_policy: "always"
    });

    expect(result).toEqual({
      ok: true,
      data: {
        worker: "R-06",
        thread_id: "thread-222",
        status: "done",
        run_state: "completed",
        summary: "Worker completed"
      }
    });
    expect(sendAndWaitMock).toHaveBeenCalledTimes(2);
    expect(sendAndWaitMock.mock.calls[1]?.[0]).toMatchObject({
      intent: "kill",
      target: "thread-222",
      thread_id: "thread-222"
    });
  });

  it("kills failed worker threads when kill_policy is always", async () => {
    sendAndWaitMock
      .mockResolvedValueOnce(buildHubResult("Worker failed", "error"))
      .mockResolvedValueOnce(buildHubResult("", "success"));
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-333",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "R-07",
      kill_policy: "always"
    });

    expect(result).toEqual({
      ok: false,
      error: "Worker failed",
      data: {
        worker: "R-07",
        thread_id: "thread-333",
        status: "failed"
      }
    });
    expect(sendAndWaitMock).toHaveBeenCalledTimes(2);
    expect(sendAndWaitMock.mock.calls[1]?.[0]).toMatchObject({
      intent: "kill",
      target: "thread-333",
      thread_id: "thread-333"
    });
  });

  it("does not kill failed worker threads when kill_policy is on_success", async () => {
    sendAndWaitMock.mockResolvedValue(buildHubResult("Worker failed", "error"));
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-444",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "R-08",
      kill_policy: "on_success"
    });

    expect(result).toEqual({
      ok: false,
      error: "Worker failed",
      data: {
        worker: "R-08",
        thread_id: "thread-444",
        status: "failed"
      }
    });
    expect(sendAndWaitMock).toHaveBeenCalledTimes(1);
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

  it("swallows reconciliation failures while still returning the run result", async () => {
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

  it("grants DELTA-CHECK workers permission to modify the dispatch plan", async () => {
    sendAndWaitMock.mockResolvedValue(buildHubResult("Delta check done", "success"));
    mockCommandAndPlanReads("/tmp/dispatch/agent_dispatch_command.md", [
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| 🔄 | 5 | DELTA-CHECK | Delta Check & Corrective Dispatch | CODEX-XHIGH | N-01 | One pass only |"
    ].join("\n"));

    await runTool.execute({
      thread_id: "thread-dc",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "DELTA-CHECK"
    });

    const sentPayload = sendAndWaitMock.mock.calls[0]?.[0] as { payload: { content: string } };
    expect(sentPayload.payload.content).toContain("may add, remove, or modify rows");
    expect(sentPayload.payload.content).toContain("**must** write your findings");
    expect(sentPayload.payload.content).not.toContain("you do not need to write to the dispatch plan yourself");
  });

  it("does not grant plan modification to regular workers", async () => {
    sendAndWaitMock.mockResolvedValue(buildHubResult("Worker done", "success"));
    mockCommandAndPlanReads("/tmp/dispatch/agent_dispatch_command.md", [
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| 🔄 | 1 | N-01 | Build feature | CODEX | — | — |"
    ].join("\n"));

    await runTool.execute({
      thread_id: "thread-n01",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-01"
    });

    const sentPayload = sendAndWaitMock.mock.calls[0]?.[0] as { payload: { content: string } };
    expect(sentPayload.payload.content).toContain("you do not need to write to the dispatch plan yourself");
    expect(sentPayload.payload.content).not.toContain("may add, remove, or modify rows");
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

function mockCommandAndPlanReads(commandPath: string, dispatchPlan: string): void {
  readFileMock.mockImplementation(async (filePath) => {
    if (filePath === commandPath) {
      return "# command\n";
    }

    if (filePath === "/tmp/dispatch/dispatch_plan.md") {
      return dispatchPlan;
    }

    throw new Error(`Unexpected readFile path: ${String(filePath)}`);
  });
}
