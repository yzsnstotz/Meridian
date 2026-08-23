import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lifecycleStoreConstructor, reconcileMock } = vi.hoisted(() => ({
  reconcileMock: vi.fn().mockResolvedValue({
    changed: [],
    unchanged: []
  }),
  lifecycleStoreConstructor: vi.fn().mockImplementation((filePath: string) => {
    const workers: Record<string, Record<string, unknown>> = {};

    return {
      filePath,
      recordWorkerStart: vi.fn((
        workerId: string,
        threadId: string,
        traceId: string,
        expectedOutputs: string[],
        _commandPreamble?: string | null,
        options?: { validationMaxFixCycles?: number }
      ) => {
        const previousRetryCount = typeof workers[workerId]?.retry_count === "number"
          ? workers[workerId].retry_count as number
          : 0;
        workers[workerId] = {
          thread_id: threadId,
          trace_id: traceId,
          status: "running",
          expected_outputs: [...expectedOutputs],
          hub_result: null,
          retry_count: previousRetryCount,
          ...(options?.validationMaxFixCycles
            ? {
                validation: {
                  current_cycle: 0,
                  max_fix_cycles: options.validationMaxFixCycles,
                  validator_thread_id: null,
                  last_score: null,
                  last_feedback: null,
                  history: []
                }
              }
            : {})
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
        const completed = hubResult.status === "success"
          && (!hubResult.run_state || hubResult.run_state === "completed")
          && !requiresOutputVerification;
        workers[workerId] = {
          ...worker,
          status: hubResult.status === "error"
            ? "failed"
            : completed
              ? worker.validation
                ? "awaiting_validation"
                : "completed"
              : "running",
          hub_result: hubResult
        };
      }),
      setWorkerStatus: vi.fn((
        workerId: string,
        status: string,
        _trigger: string,
        options: { clearHubResult?: boolean; incrementRetryCount?: boolean } = {}
      ) => {
        const worker = workers[workerId];
        if (!worker) {
          throw new Error(`Worker not found: ${workerId}`);
        }

        const previousRetryCount = typeof worker.retry_count === "number"
          ? worker.retry_count as number
          : 0;
        workers[workerId] = {
          ...worker,
          status,
          hub_result: options.clearHubResult ? null : worker.hub_result,
          retry_count: options.incrementRetryCount && status === "pending"
            ? previousRetryCount + 1
            : previousRetryCount
        };
      }),
      load: vi.fn(() => ({
        workers: structuredClone(workers)
      }))
    };
  })
}));

const mockRun = vi.fn();
const mockKill = vi.fn();

vi.mock("../../../roles/agent-dispatcher/meridian-api-client", () => ({
  createMeridianApiClient: () => ({
    run: mockRun,
    kill: mockKill
  })
}));

vi.mock("../../ipc-bridge", () => ({
  sendViaHttpRelay: vi.fn()
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn()
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  access: vi.fn()
}));

vi.mock("../../../roles/agent-dispatcher/lifecycle-store", () => ({
  LifecycleStore: lifecycleStoreConstructor,
  isExplicitCompletionContent: (content: string) => /✅/.test(content) && /\bcomplete\b/i.test(content)
}));

vi.mock("../../../roles/agent-dispatcher/reconciler", () => ({
  reconcile: reconcileMock
}));

import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";

import type { HubResult, HubResultStatus, HubRunState } from "../../../types";
import runTool from "../run";

type MockLifecycleStore = {
  filePath: string;
  recordWorkerStart: ReturnType<typeof vi.fn>;
  recordWorkerResult: ReturnType<typeof vi.fn>;
  setWorkerStatus: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
};

const randomUUIDMock = vi.mocked(randomUUID);
const readFileMock = vi.mocked(readFile);
const accessMock = vi.mocked(access);

beforeEach(() => {
  randomUUIDMock.mockReturnValue("11111111-1111-4111-8111-111111111111");
  // Default: every previous-attempt-context probe finds the artifact on disk.
  accessMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("run tool", () => {
  it("derives expected outputs from dispatch-plan notes before sendAndWait", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    readFileMock.mockImplementation(async (filePath) => {
      if (filePath === "/tmp/dispatch/agent_dispatch_command.md") {
        return [
          "# Agent Dispatch Command",
          "",
          "# Role Definition",
          "Follow the embedded command text rather than the command path."
        ].join("\n");
      }

      if (filePath === "/tmp/dispatch/dispatch_plan.md") {
        return [
          "# Dispatch Plan",
          "",
          "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
          "|--------|-------|--------|------|-------|------------|-------|",
          "| 🔄 | 4 | N-04 | Ship outputs | CODEX | N-03 | Read `input.txt`, write `final.txt`, and append a line to `audit.txt`. |"
        ].join("\n");
      }

      throw new Error(`Unexpected readFile path: ${String(filePath)}`);
    });
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
      mockRun.mock.invocationCallOrder[0]
    );
    const sentContent = mockRun.mock.calls[0]?.[0]?.content as string;
    expect(sentContent).toContain("You are **CODEX**");
    expect(sentContent).toContain("worker **N-04**");
    expect(sentContent).toContain("**N-04**: Ship outputs");
    expect(sentContent).toContain("# Dispatch Command");
    expect(sentContent).toContain("/tmp/dispatch/agent_dispatch_command.md");
    expect(sentContent).not.toContain("# Agent Dispatch Command");
    expect(sentContent).not.toContain("# Role Definition");
    expect(lifecycleStore.recordWorkerResult).toHaveBeenCalledWith("N-04", hubResult);
    expect(mockRun.mock.invocationCallOrder[0]).toBeLessThan(
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

  it("resolves dispatch artifact outputs from notes under the command directory", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    readFileMock.mockImplementation(async (filePath) => {
      if (filePath === "/tmp/dispatch/agent_dispatch_command.md") {
        return "# Agent Dispatch Command\n";
      }

      if (filePath === "/tmp/dispatch/dispatch_plan.md") {
        return [
          "# Dispatch Plan",
          "",
          "| Status | Batch | Worker | Task | Model | Depends On | Report File | Notes |",
          "|--------|-------|--------|------|-------|------------|-------------|-------|",
          "| 🔄 | 3 | OBS-STOP | Stop sampler | CODEX | SMOKE | reports/OBS-STOP.md | Produce `observability/summary.md`. |"
        ].join("\n");
      }

      throw new Error(`Unexpected readFile path: ${String(filePath)}`);
    });

    await runTool.execute({
      thread_id: "thread-obs-stop",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "OBS-STOP"
    });

    const lifecycleStore = getLifecycleStore();

    expect(lifecycleStore.recordWorkerStart).toHaveBeenCalledWith(
      "OBS-STOP",
      "thread-obs-stop",
      "11111111-1111-4111-8111-111111111111",
      ["/tmp/dispatch/reports/OBS-STOP.md", "/tmp/dispatch/observability/summary.md"],
      expect.any(String)
    );
  });

  it("emits a slim preamble that references the command file path instead of inlining its body", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    mockCommandAndPlanReads("/tmp/dispatch/agent_dispatch_command.md", [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| 🔄 | 4 | N-04 | Ship outputs | CODEX | N-03 | No non-report outputs required. |"
    ].join("\n"));

    await runTool.execute({
      thread_id: "thread-slim",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-04"
    });

    const sentContent = mockRun.mock.calls[0]?.[0]?.content as string;

    // Slim contract assertions:
    expect(sentContent).toContain("# Dispatch Command");
    expect(sentContent).not.toContain("# Runtime Notes");
    expect(sentContent).not.toContain("Step 4a");
    expect(sentContent).not.toContain("Step 5b");
    expect(sentContent).not.toContain("writable sandbox");
    expect(sentContent).toContain("/tmp/dispatch/agent_dispatch_command.md");
    expect(sentContent).not.toContain("# Embedded Dispatch Command");
    expect(sentContent).not.toContain("# Runtime Overrides");
    expect(sentContent).not.toContain("# Role Definition");
    expect(sentContent).not.toContain("# Agent Dispatch Command");

    // Body-content negative anchor: mockCommandAndPlanReads stubs the command
    // file body as `"# command\n"`. Under the slim, the preamble must not inline
    // that body, so its lowercase `# command` header must not appear in the
    // sent content (the preamble uses `# Dispatch Command`, capital C).
    expect(sentContent).not.toContain("# command");

    // Sanity: preamble length is bounded. The legacy preamble inlined the
    // command file body; the slim preamble for this fixture is well under 2 kB.
    expect(sentContent.length).toBeLessThan(2000);
  });

  it("parses model::effort in dispatch rows and keeps the preamble identity clean", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    mockCommandAndPlanReads("/tmp/dispatch/agent_dispatch_command.md", [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| 🔄 | 4 | N-04 | Ship outputs | CODEX::high | N-03 | Read `input.txt`, write `final.txt`. |"
    ].join("\n"));

    await runTool.execute({
      thread_id: "thread-effort",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-04"
    });

    const sentContent = mockRun.mock.calls[0]?.[0]?.content as string;
    expect(sentContent).toContain("You are **CODEX**");
    expect(sentContent).not.toContain("CODEX::high");
  });

  it("accepts a reasoning_effort column in dispatch rows", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    mockCommandAndPlanReads("/tmp/dispatch/agent_dispatch_command.md", [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Reasoning Effort | Depends On | Notes |",
      "|--------|-------|--------|------|-------|-----------------|------------|-------|",
      "| 🔄 | 4 | N-04 | Ship outputs | CODEX | high | N-03 | Read `input.txt`, write `final.txt`. |"
    ].join("\n"));

    await runTool.execute({
      thread_id: "thread-effort-column",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-04"
    });

    const sentContent = mockRun.mock.calls[0]?.[0]?.content as string;
    expect(sentContent).toContain("You are **CODEX**");
  });

  it("includes the Reply Protocol section with a MeridianStatusMarker template for non-dispatcher workers", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    mockCommandAndPlanReads("/tmp/dispatch/agent_dispatch_command.md", [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| 🔄 | 1 | N-04 | Ship outputs | CODEX | N-03 | No non-report outputs required. |"
    ].join("\n"));

    await runTool.execute({
      thread_id: "thread-protocol",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-04"
    });

    const sentContent = mockRun.mock.calls[0]?.[0]?.content as string;

    // Heading and marker boundaries must appear verbatim.
    expect(sentContent).toContain("# Reply Protocol");
    expect(sentContent).toContain("<<<MERIDIAN-STATUS>>>");
    expect(sentContent).toContain("<<<END>>>");

    // Worker id is substituted into the template at preamble build time.
    expect(sentContent).toContain("worker_id: N-04");
    expect(sentContent).toContain("role: worker");

    // The outcome enum line must list all five values from the worker schema.
    expect(sentContent).toContain("outcome: complete | failed | blocked | hit_limit | needs_pm");

    // Per-outcome bullet block + escape note carry load-bearing semantics that
    // A2's lifecycle reconciliation depends on the worker reading.
    expect(sentContent).toContain("Lifecycle treats this as `failed`");
    expect(sentContent).toContain("wrap that example in a fenced code block");
  });

  it("omits the Reply Protocol section from the dispatcher controller preamble", async () => {
    const hubResult = buildHubResult("Dispatcher paused", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    mockCommandAndPlanReads("/tmp/dispatch/agent_dispatch_command.md", [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| 🔄 | Ω+2 | DISPATCHER | Drive the next eligible worker | CODEX | DELTA-CHECK | Controller row. |"
    ].join("\n"));

    await runTool.execute({
      thread_id: "dispatcher-thread-protocol",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "DISPATCHER"
    });

    const sentContent = mockRun.mock.calls[0]?.[0]?.content as string;

    // Phase A only defines a worker-role marker; the dispatcher itself has no
    // schema, so the protocol section must be skipped for it.
    expect(sentContent).not.toContain("# Reply Protocol");
    expect(sentContent).not.toContain("<<<MERIDIAN-STATUS>>>");
    expect(sentContent).not.toContain("<<<END>>>");
  });

  it("places the Reply Protocol section between # Status and # Dispatch Command", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    mockCommandAndPlanReads("/tmp/dispatch/agent_dispatch_command.md", [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| 🔄 | 1 | N-04 | Ship outputs | CODEX | N-03 | No non-report outputs required. |"
    ].join("\n"));

    await runTool.execute({
      thread_id: "thread-protocol-order",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-04"
    });

    const sentContent = mockRun.mock.calls[0]?.[0]?.content as string;

    const statusIndex = sentContent.indexOf("# Status");
    const protocolIndex = sentContent.indexOf("# Reply Protocol");
    const dispatchIndex = sentContent.indexOf("# Dispatch Command");

    expect(statusIndex).toBeGreaterThanOrEqual(0);
    expect(protocolIndex).toBeGreaterThan(statusIndex);
    expect(dispatchIndex).toBeGreaterThan(protocolIndex);
  });

  it("derives worker-specific report outputs from dispatch-plan notes with angle-bracket placeholders", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    mockCommandAndPlanReads("/tmp/dispatch/agent_dispatch_command.md", [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| 🔄 | 1 | R-01 | Write report | CODEX | PRE-FLIGHT | Write results to `/tmp/dispatch/reports/<WORKER_ID>.md`. |"
    ].join("\n"));

    await runTool.execute({
      thread_id: "thread-r01-notes",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "R-01"
    });

    const lifecycleStore = getLifecycleStore();
    expect(lifecycleStore.recordWorkerStart).toHaveBeenCalledWith(
      "R-01",
      "thread-r01-notes",
      "11111111-1111-4111-8111-111111111111",
      ["/tmp/dispatch/reports/R-01.md"],
      expect.any(String)
    );
  });

  it("derives mixed-syntax report-file outputs from the dispatch plan", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    mockCommandAndPlanReads("/tmp/dispatch/agent_dispatch_command.md", [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | File | Notes |",
      "|--------|-------|--------|------|-------|------------|------|-------|",
      "| 🔄 | 1 | R-01 | Mixed syntax report | CODEX | PRE-FLIGHT | reports/[WORKER_ID]-<WORKER_ID>.md | No non-report outputs required. |"
    ].join("\n"));

    await runTool.execute({
      thread_id: "thread-r01-file",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "R-01"
    });

    const lifecycleStore = getLifecycleStore();
    expect(lifecycleStore.recordWorkerStart).toHaveBeenCalledWith(
      "R-01",
      "thread-r01-file",
      "11111111-1111-4111-8111-111111111111",
      ["/tmp/dispatch/reports/R-01-R-01.md"],
      expect.any(String)
    );
  });

  it("does not treat implementation workers as report-only just because their completion artifact is a report", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    mockCommandAndPlanReads("/tmp/dispatch/agent_dispatch_command.md", [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| 🔄 | 1 | N-01 | Fix OpenClaw setup flow | CODEX | PRE-FLIGHT | Write completion report to `/tmp/dispatch/reports/<WORKER_ID>.md`. |"
    ].join("\n"));

    await runTool.execute({
      thread_id: "thread-implementation-report",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-01"
    });

    const sentContent = mockRun.mock.calls[0]?.[0]?.content as string;
    expect(sentContent).not.toContain("Steps 4b–4f, 5c–5d");
    expect(sentContent).toContain("# Dispatch Command");
    expect(sentContent).not.toContain("this is a report-only worker");
    expect(sentContent).not.toContain("preserve the command file's NO-GIT delivery mode");
  });

  it("does not inject NO-GIT delivery instructions into the preamble", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    readFileMock.mockImplementation(async (filePath) => {
      if (filePath === "/tmp/dispatch/agent_dispatch_command.md") {
        return [
          "# Dispatch Command",
          "",
          "Mode: NO-GIT",
          "",
          "Workers MUST NOT run `git init`, `git add`, `git commit`, `git push`, or `gh pr create`.",
          "Workers write markdown deliverables directly to confirmed paths.",
          "",
          "Write completion report to:",
          "```",
          "/tmp/dispatch/reports/<WORKER_ID>.md",
          "```"
        ].join("\n");
      }

      if (filePath === "/tmp/dispatch/dispatch_plan.md") {
        return [
          "# Dispatch Plan",
          "",
          "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
          "|--------|-------|--------|------|-------|------------|-------|",
          "| 🔄 | 1 | N-01 | Extract app artifacts | CODEX | — | Foundation output. |"
        ].join("\n");
      }

      throw new Error(`Unexpected readFile path: ${String(filePath)}`);
    });

    await runTool.execute({
      thread_id: "thread-no-git-implementation",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-01"
    });

    const sentContent = mockRun.mock.calls[0]?.[0]?.content as string;
    // The worker reads the command file directly (it's referenced in
    // # Dispatch Command). NO-GIT mode lives in that file, not echoed into
    // the preamble — the preamble must stay role-agnostic.
    expect(sentContent).not.toContain("preserve the command file's NO-GIT delivery mode");
    expect(sentContent).not.toContain("Steps 4b–4f, 5c–5d");
    expect(sentContent).toContain("# Dispatch Command");
  });

  it("does not echo report-only suppression bullets into the preamble", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    mockCommandAndPlanReads("/tmp/dispatch/agent_dispatch_command.md", [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| 🔄 | 1 | R-01 | Report-only audit | CODEX | PRE-FLIGHT | Write completion report to `/tmp/dispatch/reports/<WORKER_ID>.md`. |"
    ].join("\n"));

    await runTool.execute({
      thread_id: "thread-explicit-report-only",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "R-01"
    });

    const sentContent = mockRun.mock.calls[0]?.[0]?.content as string;
    // Report-only is a command-file concern; the preamble must not echo
    // hardcoded report-only bullets keyed off worker IDs or notes regex.
    expect(sentContent).not.toContain("this is a report-only worker");
    expect(sentContent).not.toContain("Steps 5c–5d");
    expect(sentContent).toContain("# Dispatch Command");
  });

  it("does not special-case PRE-FLIGHT control workers in the preamble", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    mockCommandAndPlanReads("/tmp/dispatch/agent_dispatch_command.md", [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| 🔄 | 0 | PRE-FLIGHT | Environment health check | CODEX | — | Write completion report to `/tmp/dispatch/reports/<WORKER_ID>.md`. |"
    ].join("\n"));

    await runTool.execute({
      thread_id: "thread-preflight-control",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "PRE-FLIGHT"
    });

    const sentContent = mockRun.mock.calls[0]?.[0]?.content as string;
    expect(sentContent).not.toContain("this is a report-only worker");
    expect(sentContent).not.toContain("Steps 5c–5d");
    expect(sentContent).toContain("# Dispatch Command");
  });

  it("keeps successful workers running until reconciliation verifies real outputs", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
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
    mockRun.mockResolvedValue(toApiResult(hubResult));
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

  it("derives the completion report path from the dispatch command template with angle-bracket placeholders", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    readFileMock.mockImplementation(async (filePath) => {
      if (filePath === "/tmp/dispatch/agent_dispatch_command.md") {
        return [
          "# Agent Dispatch Command",
          "",
          "Write your completion report to:",
          "```",
          "/tmp/dispatch/dev_history/v1_round/<WORKER_ID>_report.md",
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
      thread_id: "thread-234-angle",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-04"
    });

    const lifecycleStore = getLifecycleStore();
    expect(lifecycleStore.recordWorkerStart).toHaveBeenCalledWith(
      "N-04",
      "thread-234-angle",
      "11111111-1111-4111-8111-111111111111",
      ["/tmp/dispatch/dev_history/v1_round/N-04_report.md"],
      expect.any(String)
    );
  });

  it("derives the completion report path when the command omits the word your", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    readFileMock.mockImplementation(async (filePath) => {
      if (filePath === "/tmp/dispatch/agent_dispatch_command.md") {
        return [
          "# Agent Dispatch Command",
          "",
          "Write completion report to:",
          "```",
          "/tmp/dispatch/reports/[WORKER_ID].md",
          "```"
        ].join("\n");
      }

      if (filePath === "/tmp/dispatch/dispatch_plan.md") {
        return [
          "# Dispatch Plan",
          "",
          "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
          "|--------|-------|--------|------|-------|------------|-------|",
          "| 🔄 | 0 | PRE-FLIGHT | Environment check | OPUS | — | Report-only worker. |"
        ].join("\n");
      }

      throw new Error(`Unexpected readFile path: ${String(filePath)}`);
    });

    await runTool.execute({
      thread_id: "thread-preflight",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "PRE-FLIGHT"
    });

    const lifecycleStore = getLifecycleStore();
    expect(lifecycleStore.recordWorkerStart).toHaveBeenCalledWith(
      "PRE-FLIGHT",
      "thread-preflight",
      "11111111-1111-4111-8111-111111111111",
      ["/tmp/dispatch/reports/PRE-FLIGHT.md"],
      expect.any(String)
    );
  });

  it("overrides scheduler worker reports into the active run directory", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    readFileMock.mockImplementation(async (filePath) => {
      if (filePath === "/tmp/dispatch/agent_dispatch_command.md") {
        return [
          "# Agent Dispatch Command",
          "",
          "Write completion report to:",
          "```",
          "/tmp/dispatch/reports/[WORKER_ID].md",
          "```"
        ].join("\n");
      }

      if (filePath === "/tmp/dispatch/dispatch_plan.md") {
        return [
          "# Dispatch Plan",
          "",
          "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
          "|--------|-------|--------|------|-------|------------|-------|",
          "| 🔄 | 0 | PRE-FLIGHT | Environment check | OPUS | — | Report-only worker. |"
        ].join("\n");
      }

      if (filePath === "/tmp/dispatch/scheduler_state.json") {
        return JSON.stringify({
          status: "active_run",
          current_run_id: "run-123",
          current_run_report_dir: "/tmp/dispatch/reports/runs/run-123"
        });
      }

      throw new Error(`Unexpected readFile path: ${String(filePath)}`);
    });

    await runTool.execute({
      thread_id: "thread-preflight-run-report",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "PRE-FLIGHT"
    });

    const lifecycleStore = getLifecycleStore();
    expect(lifecycleStore.recordWorkerStart).toHaveBeenCalledWith(
      "PRE-FLIGHT",
      "thread-preflight-run-report",
      "11111111-1111-4111-8111-111111111111",
      ["/tmp/dispatch/reports/runs/run-123/PRE-FLIGHT.md"],
      expect.any(String)
    );
    const sentContent = mockRun.mock.calls[0]?.[0]?.content as string;
    expect(sentContent).toContain("write the completion report to `/tmp/dispatch/reports/runs/run-123/PRE-FLIGHT.md`");
    expect(sentContent).toContain("supersedes any report path in the command file");
    expect(sentContent).toContain("append a new attempt section instead of replacing the existing file");
  });

  it("passes the scheduler scan run id to workers without requiring local date recomputation", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    readFileMock.mockImplementation(async (filePath) => {
      if (filePath === "/tmp/dispatch/agent_dispatch_command.md") {
        return [
          "# Agent Dispatch Command",
          "",
          "Write completion report to:",
          "```",
          "/tmp/dispatch/reports/[WORKER_ID].md",
          "```"
        ].join("\n");
      }

      if (filePath === "/tmp/dispatch/dispatch_plan.md") {
        return [
          "# Dispatch Plan",
          "",
          "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
          "|--------|-------|--------|------|-------|------------|-------|",
          "| 🔄 | 1 | W-CATALOG | Catalog sweep | CODEX-HIGH | PRE-FLIGHT | Writes manifest. |"
        ].join("\n");
      }

      if (filePath === "/tmp/dispatch/scheduler_state.json") {
        return JSON.stringify({
          status: "active_run",
          current_run_id: "run-123",
          current_run_report_dir: "/tmp/dispatch/reports/run/run-123",
          current_scan_run_id: "daily-2026-04-25"
        });
      }

      throw new Error(`Unexpected readFile path: ${String(filePath)}`);
    });

    await runTool.execute({
      thread_id: "thread-catalog-scan-id",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "W-CATALOG"
    });

    const sentContent = mockRun.mock.calls[0]?.[0]?.content as string;
    expect(sentContent).toContain("# Scheduler Cycle Context");
    expect(sentContent).toContain("SCHEDULER_RUN_ID: run-123");
    expect(sentContent).toContain("SCAN_RUN_ID: daily-2026-04-25");
    expect(sentContent).toContain("Use this exact `SCAN_RUN_ID`; do not recompute it from the local date.");
  });

  it("derives the completion report path with angle-bracket placeholders when the command omits the word your", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    readFileMock.mockImplementation(async (filePath) => {
      if (filePath === "/tmp/dispatch/agent_dispatch_command.md") {
        return [
          "# Agent Dispatch Command",
          "",
          "Write completion report to:",
          "```",
          "/tmp/dispatch/reports/<WORKER_ID>.md",
          "```"
        ].join("\n");
      }

      if (filePath === "/tmp/dispatch/dispatch_plan.md") {
        return [
          "# Dispatch Plan",
          "",
          "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
          "|--------|-------|--------|------|-------|------------|-------|",
          "| 🔄 | 0 | PRE-FLIGHT | Environment check | OPUS | — | Report-only worker. |"
        ].join("\n");
      }

      throw new Error(`Unexpected readFile path: ${String(filePath)}`);
    });

    await runTool.execute({
      thread_id: "thread-preflight-angle",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "PRE-FLIGHT"
    });

    const lifecycleStore = getLifecycleStore();
    expect(lifecycleStore.recordWorkerStart).toHaveBeenCalledWith(
      "PRE-FLIGHT",
      "thread-preflight-angle",
      "11111111-1111-4111-8111-111111111111",
      ["/tmp/dispatch/reports/PRE-FLIGHT.md"],
      expect.any(String)
    );
  });

  it("derives the completion report path from an inline command template", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    readFileMock.mockImplementation(async (filePath) => {
      if (filePath === "/tmp/dispatch/agent_dispatch_command.md") {
        return [
          "# Agent Dispatch Command",
          "",
          "5l: Write completion report to: `/tmp/dispatch/reports/<WORKER_ID>.md`"
        ].join("\n");
      }

      if (filePath === "/tmp/dispatch/dispatch_plan.md") {
        return [
          "# Dispatch Plan",
          "",
          "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
          "|--------|-------|--------|------|-------|------------|-------|",
          "| 🔄 | 4 | R-03 | Recovery | CODEX | — | Report-only worker. |"
        ].join("\n");
      }

      throw new Error(`Unexpected readFile path: ${String(filePath)}`);
    });

    await runTool.execute({
      thread_id: "thread-inline-report",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "R-03"
    });

    const lifecycleStore = getLifecycleStore();
    expect(lifecycleStore.recordWorkerStart).toHaveBeenCalledWith(
      "R-03",
      "thread-inline-report",
      "11111111-1111-4111-8111-111111111111",
      ["/tmp/dispatch/reports/R-03.md"],
      expect.any(String)
    );
  });

  it("keeps the dispatcher wrapper in control-flow mode instead of implementation mode", async () => {
    const hubResult = buildHubResult("Dispatcher paused", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
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

    const sentContent = mockRun.mock.calls[0]?.[0]?.content as string;
    expect(sentContent).toContain("You are the dispatcher controller.");
    expect(sentContent).toContain("Treat any local Meridian tool bootstrap failure");
    // The preamble must not leak protocol-specific Step numbering or repo
    // delivery bullets — the command file owns that. The dispatcher prompt
    // is responsible for control-flow scope.
    expect(sentContent).not.toContain("# Runtime Notes");
    expect(sentContent).not.toContain("Step 4a");
    expect(sentContent).not.toContain("Step 5b");
    expect(sentContent).not.toContain("create extra repo artifacts");
    expect(sentContent).not.toContain("completion report): attempt to write the report");
  });

  it("prefers the DELTA-CHECK-specific report path over the generic completion template", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
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

  it("prefers the DELTA-CHECK-specific report path over an angle-bracket completion template", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    readFileMock.mockImplementation(async (filePath) => {
      if (filePath === "/tmp/dispatch/agent_dispatch_command.md") {
        return [
          "# Agent Dispatch Command",
          "",
          "Write your completion report to:",
          "```",
          "/tmp/dispatch/dev_history/v1_round/<WORKER_ID>_report.md",
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
      thread_id: "thread-delta-angle",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "DELTA-CHECK"
    });

    const lifecycleStore = getLifecycleStore();
    expect(lifecycleStore.recordWorkerStart).toHaveBeenCalledWith(
      "DELTA-CHECK",
      "thread-delta-angle",
      "11111111-1111-4111-8111-111111111111",
      ["/tmp/dispatch/dev_history/v1_round/delta_check_report.md"],
      expect.any(String)
    );
  });

  it("resolves dispatch-plan-relative delta repair artifacts under the plan directory", async () => {
    const planDirectory = "/workspace/Meridian/docs/branch/feat-cli-external-integration";
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    readFileMock.mockImplementation(async (filePath) => {
      if (filePath === `${planDirectory}/agent_dispatch_command.md`) {
        return "# Agent Dispatch Command\n";
      }

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
      ["/workspace/Meridian/docs/branch/feat-cli-external-integration/dev_history/v1_round/delta_check_report.md"],
      expect.any(String)
    );
  });

  it("keeps a special-node report path when generic Step 5b is dispatch-plan-relative", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
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

  it("keeps a special-node report path when the generic Step 5b template uses angle-bracket placeholders", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    readFileMock.mockImplementation(async (filePath) => {
      if (filePath === "/tmp/repo/docs/branch/feat/agent_dispatch_command.md") {
        return [
          "# Agent Dispatch Command",
          "",
          "Write your completion report to:",
          "```",
          "dev_history/v1_round/<WORKER_ID>_report.md",
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
      thread_id: "thread-delta-angle",
      command: "/tmp/repo/docs/branch/feat/agent_dispatch_command.md",
      worker: "DELTA-CHECK"
    });

    const lifecycleStore = getLifecycleStore();
    expect(lifecycleStore.recordWorkerStart).toHaveBeenCalledWith(
      "DELTA-CHECK",
      "thread-delta-angle",
      "11111111-1111-4111-8111-111111111111",
      ["/tmp/repo/docs/branch/feat/dev_history/v1_round/delta_check_report.md"],
      expect.any(String)
    );
  });

  it("injects slim prior-attempt context (paths only, no inlined bodies) when a worker is redone", async () => {
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

    mockRun.mockResolvedValue(toApiResult(buildHubResult("Worker completed", "success")));
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

      throw new Error(`Unexpected readFile path: ${String(filePath)}`);
    });

    await runTool.execute({
      thread_id: "thread-123",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-04"
    });

    const sentContent = mockRun.mock.calls[0]?.[0]?.content as string;
    expect(sentContent).toContain("# Previous Attempt Context");
    expect(sentContent).toContain("Re-check current state from disk before acting");
    expect(sentContent).toContain("- Previous worker thread: `thread-prev`");
    expect(sentContent).toContain("- Previous output artifact: `/tmp/dispatch/dev_history/v1_round/N-04_report.md`");
    // Slim contract: no inlined report bodies or prior agent replies.
    expect(sentContent).not.toContain("Watch the same GUI drift again.");
    expect(sentContent).not.toContain("# Earlier Report");
    expect(sentContent).not.toContain("Previous agent reply:");
  });

  it("injects slim prior-attempt context for angle-bracket report templates", async () => {
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

    mockRun.mockResolvedValue(toApiResult(buildHubResult("Worker completed", "success")));
    readFileMock.mockImplementation(async (filePath) => {
      if (filePath === "/tmp/dispatch/agent_dispatch_command.md") {
        return [
          "# Agent Dispatch Command",
          "",
          "Write your completion report to:",
          "```",
          "/tmp/dispatch/dev_history/v1_round/<WORKER_ID>_report.md",
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

      throw new Error(`Unexpected readFile path: ${String(filePath)}`);
    });

    await runTool.execute({
      thread_id: "thread-123-angle",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-04"
    });

    const sentContent = mockRun.mock.calls[0]?.[0]?.content as string;
    expect(sentContent).toContain("# Previous Attempt Context");
    expect(sentContent).toContain("Re-check current state from disk before acting");
    expect(sentContent).toContain("- Previous worker thread: `thread-prev`");
    expect(sentContent).toContain("- Previous output artifact: `/tmp/dispatch/dev_history/v1_round/N-04_report.md`");
    expect(sentContent).not.toContain("Watch the same GUI drift again.");
    expect(sentContent).not.toContain("# Earlier Report");
    expect(sentContent).not.toContain("Previous agent reply:");
  });

  it("surfaces structured still_running results without flattening them to done", async () => {
    mockRun.mockResolvedValue(toApiResult(buildHubResult("Worker still running", "partial", "still_running")));
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
    mockRun.mockResolvedValue(toApiResult(hubResult));
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

  it("does not kill successful workers when lifecycle remains running after reconciliation", async () => {
    const hubResult = buildHubResult("Worker completed", "success");
    mockRun.mockResolvedValue(toApiResult(hubResult));
    mockCommandAndPlanReads("/tmp/dispatch/agent_dispatch_command.md", [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "|--------|-------|--------|------|-------|------------|-------|",
      "| 🔄 | 4 | R-06 | Ship outputs | CODEX | R-05 | Read `input.txt`, write `final.txt`, and append a line to `audit.txt`. |"
    ].join("\n"));

    const result = await runTool.execute({
      thread_id: "thread-221",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "R-06",
      kill_policy: "always"
    });

    const lifecycleStore = getLifecycleStore();

    expect(result).toEqual({
      ok: true,
      data: {
        worker: "R-06",
        thread_id: "thread-221",
        status: "done",
        run_state: "completed",
        summary: "Worker completed"
      }
    });
    expect(lifecycleStore.load().workers["R-06"]).toMatchObject({
      status: "running"
    });
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it("kills successful workers when lifecycle is completed and kill_policy is always", async () => {
    mockRun.mockResolvedValueOnce(toApiResult(buildHubResult("Worker completed", "success")));
    mockKill.mockResolvedValueOnce({ threadId: "thread-222b", status: "success", raw: {} });
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-222b",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "R-06B",
      kill_policy: "always"
    });

    const lifecycleStore = getLifecycleStore();

    expect(result).toEqual({
      ok: true,
      data: {
        worker: "R-06B",
        thread_id: "thread-222b",
        status: "done",
        run_state: "completed",
        summary: "Worker completed"
      }
    });
    expect(lifecycleStore.load().workers["R-06B"]).toMatchObject({
      status: "completed"
    });
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockKill).toHaveBeenCalledWith("thread-222b");
  });

  it("retains successful workers for validation even when kill_policy is always", async () => {
    mockRun.mockResolvedValueOnce(toApiResult(buildHubResult("Worker completed", "success")));
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-validator-retained",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-04",
      kill_policy: "always",
      validator_max_fix_cycles: "3"
    });

    const lifecycleStore = getLifecycleStore();

    expect(result).toEqual({
      ok: true,
      data: {
        worker: "N-04",
        thread_id: "thread-validator-retained",
        status: "done",
        run_state: "completed",
        summary: "Worker completed"
      }
    });
    expect(lifecycleStore.recordWorkerStart).toHaveBeenCalledWith(
      "N-04",
      "thread-validator-retained",
      "11111111-1111-4111-8111-111111111111",
      ["/tmp/dispatch/dev_history/N-04_report.md"],
      expect.any(String),
      { validationMaxFixCycles: 3 }
    );
    expect(lifecycleStore.load().workers["N-04"]).toMatchObject({
      status: "awaiting_validation",
      validation: {
        current_cycle: 0,
        max_fix_cycles: 3,
        validator_thread_id: null,
        last_score: null,
        last_feedback: null,
        history: []
      }
    });
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockKill).not.toHaveBeenCalled();
  });

  it("falls through to the existing kill policy when lifecycle status is unavailable", async () => {
    lifecycleStoreConstructor.mockImplementationOnce((filePath: string) => ({
      filePath,
      recordWorkerStart: vi.fn(),
      recordWorkerResult: vi.fn(),
      load: vi.fn(() => ({
        workers: {}
      }))
    }));

    mockRun.mockResolvedValueOnce(toApiResult(buildHubResult("Worker completed", "success")));
    mockKill.mockResolvedValueOnce({ threadId: "thread-222c", status: "success", raw: {} });
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-222c",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "R-06C",
      kill_policy: "always"
    });

    expect(result).toEqual({
      ok: true,
      data: {
        worker: "R-06C",
        thread_id: "thread-222c",
        status: "done",
        run_state: "completed",
        summary: "Worker completed"
      }
    });
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockKill).toHaveBeenCalledWith("thread-222c");
  });

  it("kills terminal worker threads when kill_policy is always", async () => {
    mockRun.mockResolvedValueOnce(toApiResult(buildHubResult("Worker completed", "success")));
    mockKill.mockResolvedValueOnce({ threadId: "thread-222", status: "success", raw: {} });
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
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockKill).toHaveBeenCalledWith("thread-222");
  });

  it("kills failed worker threads when kill_policy is always", async () => {
    mockRun.mockResolvedValueOnce(toApiResult(buildHubResult("Worker failed", "error")));
    mockKill.mockResolvedValueOnce({ threadId: "thread-333", status: "success", raw: {} });
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
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockKill).toHaveBeenCalledWith("thread-333");
  });

  it("does not kill failed worker threads when kill_policy is on_success", async () => {
    mockRun.mockResolvedValue(toApiResult(buildHubResult("Worker failed", "error")));
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
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockKill).not.toHaveBeenCalled();
  });

  it("surfaces structured timeout results without flattening them to failure", async () => {
    mockRun.mockResolvedValue(toApiResult(buildHubResult("Wait window elapsed", "timeout", "timeout")));
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
    mockRun.mockResolvedValue(toApiResult(buildHubResult("Worker completed", "success")));
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
    mockRun.mockResolvedValue(toApiResult(buildHubResult("Hub rejected run", "error")));
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

  it("records a failed result in the lifecycle store when the API client throws a non-transient error", async () => {
    const consoleErrorMock = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockRun.mockRejectedValue(new Error("run failed: invalid request body"));
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-789",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-04"
    });

    const lifecycleStore = getLifecycleStore();

    expect(lifecycleStore.recordWorkerResult).toHaveBeenCalledWith("N-04", expect.objectContaining({
      thread_id: "thread-789",
      status: "error",
      run_state: "timeout",
      content: "run failed: invalid request body"
    }));
    expect(lifecycleStore.load().workers["N-04"]).toMatchObject({
      thread_id: "thread-789",
      status: "failed",
      hub_result: expect.objectContaining({
        status: "error",
        run_state: "timeout"
      })
    });
    expect(consoleErrorMock).toHaveBeenCalledWith("run tool execution failed", {
      worker: "N-04",
      threadId: "thread-789",
      error: "run failed: invalid request body"
    });
    expect(result).toEqual({
      ok: false,
      error: "run failed: invalid request body",
      data: {
        worker: "N-04",
        thread_id: "thread-789",
        status: "failed"
      }
    });
  });

  it("does not replay a timed-out run request into the same worker thread", async () => {
    const consoleErrorMock = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockRun.mockRejectedValue(new Error("run failed: Request timed out — the hub may be overloaded."));
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-timeout",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-04"
    });

    const lifecycleStore = getLifecycleStore();

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(lifecycleStore.recordWorkerResult).not.toHaveBeenCalled();
    expect(lifecycleStore.load().workers["N-04"]).toMatchObject({
      thread_id: "thread-timeout",
      status: "running",
      hub_result: null
    });
    expect(result).toEqual({
      ok: false,
      error: "run failed: Request timed out — the hub may be overloaded.",
      data: {
        worker: "N-04",
        thread_id: "thread-timeout",
        status: "failed"
      }
    });
    expect(consoleErrorMock).toHaveBeenCalledWith("run tool execution failed", {
      worker: "N-04",
      threadId: "thread-timeout",
      error: "run failed: Request timed out — the hub may be overloaded."
    });
  });

  it("keeps a worker running when the Hub IPC bridge drops the response (no synthetic failed)", async () => {
    // Regression for agent-dispatcher-4db5c870: the Hub returned
    // `Server error: IPC request completed without response body` for /api/run.
    // The error was treated as non-transient, runTool recorded a synthetic
    // `failed`, the worker became eligible again, and watchdog stalled into a
    // spawn storm (codex_135..139 all alive against C-01 simultaneously).
    // After the fix, the worker stays `running` so the reconciler validates
    // the actual thread state instead of triggering another launch.
    const consoleErrorMock = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockRun.mockRejectedValue(new Error(
      "run failed: Server error: IPC request completed without response body"
    ));
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-ipc-drop",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "C-01"
    });

    const lifecycleStore = getLifecycleStore();

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(lifecycleStore.recordWorkerResult).not.toHaveBeenCalled();
    expect(lifecycleStore.setWorkerStatus).not.toHaveBeenCalled();
    expect(lifecycleStore.load().workers["C-01"]).toMatchObject({
      thread_id: "thread-ipc-drop",
      status: "running",
      hub_result: null
    });
    expect(result).toEqual({
      ok: false,
      error: "run failed: Server error: IPC request completed without response body",
      data: {
        worker: "C-01",
        thread_id: "thread-ipc-drop",
        status: "failed"
      }
    });
    expect(consoleErrorMock).toHaveBeenCalledWith("run tool execution failed", {
      worker: "C-01",
      threadId: "thread-ipc-drop",
      error: "run failed: Server error: IPC request completed without response body"
    });
  });

  it("keeps a Meridian API headers timeout running because the worker may have started", async () => {
    const consoleErrorMock = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockRun.mockRejectedValue(new Error(
      "run failed: Meridian API unreachable at http://127.0.0.1:3000/: fetch failed (Headers Timeout Error)"
    ));
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-headers-timeout",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-04"
    });

    const lifecycleStore = getLifecycleStore();

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(lifecycleStore.recordWorkerResult).not.toHaveBeenCalled();
    expect(lifecycleStore.setWorkerStatus).not.toHaveBeenCalled();
    expect(lifecycleStore.load().workers["N-04"]).toMatchObject({
      thread_id: "thread-headers-timeout",
      status: "running",
      hub_result: null
    });
    expect(result).toEqual({
      ok: false,
      error: "run failed: Meridian API unreachable at http://127.0.0.1:3000/: fetch failed (Headers Timeout Error)",
      data: {
        worker: "N-04",
        thread_id: "thread-headers-timeout",
        status: "failed"
      }
    });
    expect(consoleErrorMock).toHaveBeenCalledWith("run tool execution failed", {
      worker: "N-04",
      threadId: "thread-headers-timeout",
      error: "run failed: Meridian API unreachable at http://127.0.0.1:3000/: fetch failed (Headers Timeout Error)"
    });
  });

  it("resets a connection-refused Meridian API run request to pending for scheduler retry", async () => {
    vi.useFakeTimers();
    const consoleErrorMock = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockRun.mockRejectedValue(new Error(
      "run failed: Meridian API unreachable at http://127.0.0.1:3000/: fetch failed (connect ECONNREFUSED 127.0.0.1:3000)"
    ));
    readFileMock.mockResolvedValue("# command\n");

    const pendingResult = runTool.execute({
      thread_id: "thread-unreachable",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-04"
    });

    await vi.runAllTimersAsync();
    const result = await pendingResult;
    const lifecycleStore = getLifecycleStore();

    expect(mockRun).toHaveBeenCalledTimes(3);
    expect(lifecycleStore.recordWorkerResult).not.toHaveBeenCalled();
    expect(lifecycleStore.setWorkerStatus).toHaveBeenCalledWith(
      "N-04",
      "pending",
      "run_tool_delivery_unreachable",
      {
        clearHubResult: true,
        incrementRetryCount: true
      }
    );
    expect(lifecycleStore.load().workers["N-04"]).toMatchObject({
      thread_id: "thread-unreachable",
      status: "pending",
      hub_result: null,
      retry_count: 1
    });
    expect(result).toEqual({
      ok: false,
      error: "run failed: Meridian API unreachable at http://127.0.0.1:3000/: fetch failed (connect ECONNREFUSED 127.0.0.1:3000)",
      data: {
        worker: "N-04",
        thread_id: "thread-unreachable",
        status: "failed"
      }
    });
    expect(consoleErrorMock).toHaveBeenCalledWith("run tool execution failed", {
      worker: "N-04",
      threadId: "thread-unreachable",
      error: "run failed: Meridian API unreachable at http://127.0.0.1:3000/: fetch failed (connect ECONNREFUSED 127.0.0.1:3000)"
    });
  });

  it("maps SIGINT cleanup failures to the interrupted contract", async () => {
    const consoleErrorMock = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockRun.mockRejectedValue(new Error("Tool Gateway interrupted by SIGINT"));
    readFileMock.mockResolvedValue("# command\n");

    const result = await runTool.execute({
      thread_id: "thread-999",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "N-07"
    });

    const lifecycleStore = getLifecycleStore();

    // The lifecycle store records the failure even for SIGINT so the worker
    // does not remain stuck as "running" in the lifecycle store.
    expect(lifecycleStore.recordWorkerResult).toHaveBeenCalledWith("N-07", expect.objectContaining({
      status: "error",
      content: "Tool Gateway interrupted by SIGINT"
    }));
    expect(lifecycleStore.load().workers["N-07"]).toMatchObject({
      status: "failed"
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

  it("does not hardcode plan-modify special-cases for clawso-specific worker IDs", async () => {
    // The preamble must be role-agnostic. Plan-modify permissions, report-only
    // semantics, and Step numbering belong in the command file, not in
    // hardcoded worker-ID branches in the preamble builder.
    mockRun.mockResolvedValue(toApiResult(buildHubResult("Delta check done", "success")));
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

    const sentContent = mockRun.mock.calls[0]?.[0]?.content as string;
    expect(sentContent).not.toContain("may add, remove, or modify rows");
    expect(sentContent).not.toContain("**must** write your findings");
    expect(sentContent).toContain("The lifecycle store manages all plan status updates");
  });

  it("refuses to re-dispatch a worker that is already completed", async () => {
    const completedHub: HubResult = {
      trace_id: "22222222-2222-4222-8222-222222222222",
      thread_id: "worker-thread-gate",
      source: "codex",
      status: "success",
      content: "BATCH-1-GATE complete. ✅",
      attachments: [],
      timestamp: "2026-04-20T17:05:00.000Z"
    };
    const completedWorker = {
      thread_id: "worker-thread-gate",
      trace_id: "22222222-2222-4222-8222-222222222222",
      started_at: "2026-04-20T17:00:00.000Z",
      last_seen_at: "2026-04-20T17:05:00.000Z",
      status: "completed",
      expected_outputs: [],
      hub_result: completedHub,
      retry_count: 0
    };

    // Override the constructor for this test to seed a completed worker
    lifecycleStoreConstructor.mockImplementationOnce((filePath: string) => ({
      filePath,
      recordWorkerStart: vi.fn(),
      recordWorkerResult: vi.fn(),
      load: vi.fn(() => ({
        workers: { "BATCH-1-GATE": { ...completedWorker } }
      }))
    }));

    const result = await runTool.execute({
      thread_id: "thread-new",
      command: "/tmp/dispatch/agent_dispatch_command.md",
      worker: "BATCH-1-GATE"
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      worker: "BATCH-1-GATE",
      thread_id: "worker-thread-gate",
      status: "done",
      run_state: "completed"
    });
    expect((result.data as Record<string, string>).summary).toContain("already completed");
    const lifecycleStore = getLifecycleStore();
    expect(lifecycleStore.recordWorkerStart).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("does not grant plan modification to regular workers", async () => {
    mockRun.mockResolvedValue(toApiResult(buildHubResult("Worker done", "success")));
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

    const sentContent = mockRun.mock.calls[0]?.[0]?.content as string;
    expect(sentContent).toContain("you do not need to write to the dispatch plan yourself");
    expect(sentContent).not.toContain("may add, remove, or modify rows");
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

function toApiResult(hubResult: HubResult) {
  return {
    threadId: hubResult.thread_id ?? "dispatch-thread",
    status: hubResult.status,
    runState: hubResult.run_state,
    content: hubResult.content,
    raw: hubResult
  };
}
