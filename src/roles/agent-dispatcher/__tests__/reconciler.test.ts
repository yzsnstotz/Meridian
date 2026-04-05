import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { A2AClient } from "../../../a2a/client";
import type { DispatchThreadStateV2, HubMessage, HubResult } from "../../../types";
import { buildEmptyDispatchThreadStateV2, LifecycleStore } from "../lifecycle-store";
import {
  DEFAULT_RECONCILE_STALE_TIMEOUT_MS,
  DISPATCHER_ENTRY_ID,
  reconciliationFs,
  reconcile
} from "../reconciler";

const tempDirectories = new Set<string>();
const FIXED_NOW = "2026-04-03T12:30:00.000Z";

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();

  await Promise.all(
    Array.from(tempDirectories, async (directory) => {
      await fsp.rm(directory, { recursive: true, force: true });
    })
  );

  tempDirectories.clear();
});

describe("reconcile", () => {
  it("marks a running worker completed when Hub reports completion and outputs exist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("dev_history/N-02_report.md");
    harness.store.save(buildState({
      workers: {
        "N-02": buildRunningWorker("worker-thread-111", outputPath)
      }
    }));

    const existsSpy = vi.spyOn(reconciliationFs, "existsSync");
    const statSpy = vi.spyOn(reconciliationFs, "statSync");
    const { hubClient } = createHubClient((message) => buildStatusResult(message.thread_id, "completed"));

    const report = await reconcile(harness.store, hubClient);
    const nextState = harness.store.load();

    expect(nextState.workers["N-02"]?.status).toBe("completed");
    expect(nextState.last_reconciled_at).toBe(FIXED_NOW);
    expect(report).toEqual({
      changed: [
        {
          workerId: "N-02",
          from: "running",
          to: "completed",
          trigger: "hub_status:completed:outputs_present"
        }
      ],
      unchanged: [DISPATCHER_ENTRY_ID]
    });
    expect(existsSpy).toHaveBeenCalledWith(outputPath);
    expect(statSpy).toHaveBeenCalledWith(outputPath);
  });

  it("marks a running worker completed from a stored successful HubResult when outputs exist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("test/gui-demo/step1.txt");
    harness.store.save(buildState({
      workers: {
        "A-01": {
          ...buildRunningWorker("worker-thread-111", outputPath),
          hub_result: buildTerminalSuccessResult("worker-thread-111")
        }
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => buildStatusResult(message.thread_id, "running"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["A-01"]?.status).toBe("completed");
    expect(sendRequest).not.toHaveBeenCalled();
    expect(report).toEqual({
      changed: [
        {
          workerId: "A-01",
          from: "running",
          to: "completed",
          trigger: "hub_result:outputs_present"
        }
      ],
      unchanged: [DISPATCHER_ENTRY_ID]
    });
  });

  it("marks a running worker failed when Hub reports an error state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "N-02": buildRunningWorker("worker-thread-111", path.join(harness.directory, "missing-report.md"))
      }
    }));

    const { hubClient } = createHubClient((message) => buildStatusResult(message.thread_id, "error"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["N-02"]?.status).toBe("failed");
    expect(report.changed).toEqual([
      {
        workerId: "N-02",
        from: "running",
        to: "failed",
        trigger: "hub_status:error"
      }
    ]);
  });

  it("marks a running worker completed when the thread is missing but outputs exist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("dev_history/N-02_report.md");
    harness.store.save(buildState({
      workers: {
        "N-02": buildRunningWorker("worker-thread-111", outputPath)
      }
    }));

    const { hubClient } = createHubClient((message) => buildMissingThreadResult(message.thread_id));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["N-02"]?.status).toBe("completed");
    expect(report.changed).toEqual([
      {
        workerId: "N-02",
        from: "running",
        to: "completed",
        trigger: "thread_missing:outputs_present"
      }
    ]);
  });

  it("marks a running worker abandoned when the thread is missing, outputs are absent, and the stale timeout is exceeded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "N-02": buildRunningWorker(
          "worker-thread-111",
          path.join(harness.directory, "missing-report.md"),
          "2026-04-03T12:00:00.000Z"
        )
      }
    }));

    const { hubClient } = createHubClient((message) => buildMissingThreadResult(message.thread_id));

    const report = await reconcile(harness.store, hubClient, {
      staleTimeoutMs: 5 * 60 * 1000
    });

    expect(harness.store.load().workers["N-02"]?.status).toBe("abandoned");
    expect(report.changed).toEqual([
      {
        workerId: "N-02",
        from: "running",
        to: "abandoned",
        trigger: "thread_missing:stale_timeout"
      }
    ]);
  });

  it("keeps a running worker unchanged when the thread is missing but the stale timeout has not been exceeded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "N-02": buildRunningWorker(
          "worker-thread-111",
          path.join(harness.directory, "missing-report.md"),
          "2026-04-03T12:28:00.000Z"
        )
      }
    }));

    const { hubClient } = createHubClient((message) => buildMissingThreadResult(message.thread_id));

    const report = await reconcile(harness.store, hubClient, {
      staleTimeoutMs: 5 * 60 * 1000
    });

    expect(harness.store.load().workers["N-02"]?.status).toBe("running");
    expect(report).toEqual({
      changed: [],
      unchanged: [DISPATCHER_ENTRY_ID, "N-02"]
    });
  });

  it("promotes an abandoned worker to completed when outputs exist on disk", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const outputPath = await harness.writeOutput("dev_history/N-02_report.md");
    harness.store.save(buildState({
      workers: {
        "N-02": {
          ...buildRunningWorker("worker-thread-111", outputPath),
          status: "abandoned"
        }
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => buildMissingThreadResult(message.thread_id));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["N-02"]?.status).toBe("completed");
    expect(report.changed).toEqual([
      {
        workerId: "N-02",
        from: "abandoned",
        to: "completed",
        trigger: "thread_missing:outputs_present"
      }
    ]);
  });

  it("leaves an abandoned worker unchanged when outputs are absent and thread is missing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "N-04": {
          ...buildRunningWorker("worker-thread-444", path.join(harness.directory, "missing-report.md")),
          status: "abandoned"
        }
      }
    }));

    const { hubClient } = createHubClient((message) => buildMissingThreadResult(message.thread_id));

    const report = await reconcile(harness.store, hubClient);

    // Already abandoned, no outputs, stays abandoned (no further demotion)
    expect(harness.store.load().workers["N-04"]?.status).toBe("abandoned");
    expect(report).toEqual({
      changed: [],
      unchanged: [DISPATCHER_ENTRY_ID, "N-04"]
    });
  });

  it("does not re-evaluate workers that are already completed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "N-02": {
          ...buildRunningWorker("worker-thread-111", path.join(harness.directory, "done.md")),
          status: "completed"
        }
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => buildStatusResult(message.thread_id, "completed"));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().workers["N-02"]?.status).toBe("completed");
    expect(harness.store.load().last_reconciled_at).toBe(FIXED_NOW);
    expect(sendRequest).not.toHaveBeenCalled();
    expect(report).toEqual({
      changed: [],
      unchanged: [DISPATCHER_ENTRY_ID, "N-02"]
    });
  });

  it("marks the dispatcher abandoned when its thread is missing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-03T12:00:00.000Z",
        status: "running"
      }
    }));

    const { hubClient } = createHubClient((message) => buildMissingThreadResult(message.thread_id));

    const report = await reconcile(harness.store, hubClient);

    expect(harness.store.load().dispatcher.status).toBe("abandoned");
    expect(report).toEqual({
      changed: [
        {
          workerId: DISPATCHER_ENTRY_ID,
          from: "running",
          to: "abandoned",
          trigger: "dispatcher_thread_missing"
        }
      ],
      unchanged: []
    });
  });

  it("reconciles multiple workers independently and queries Hub only for running entries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    const completedOutput = await harness.writeOutput("dev_history/R-01_report.md");
    harness.store.save(buildState({
      workers: {
        "R-01": buildRunningWorker("worker-thread-111", completedOutput),
        "R-02": buildRunningWorker(
          "worker-thread-222",
          path.join(harness.directory, "missing-R-02.md"),
          "2026-04-03T11:00:00.000Z"
        ),
        "R-03": buildRunningWorker("worker-thread-333", path.join(harness.directory, "missing-R-03.md")),
        "R-04": {
          ...buildRunningWorker("worker-thread-444", path.join(harness.directory, "done-R-04.md")),
          status: "completed"
        }
      }
    }));

    const { hubClient, sendRequest } = createHubClient((message) => {
      switch (message.thread_id) {
        case "worker-thread-111":
          return buildStatusResult(message.thread_id, "completed");
        case "worker-thread-222":
          return buildMissingThreadResult(message.thread_id);
        case "worker-thread-333":
          return buildStatusResult(message.thread_id, "error");
        default:
          return buildStatusResult(message.thread_id, "running");
      }
    });

    const report = await reconcile(harness.store, hubClient, {
      staleTimeoutMs: 10 * 60 * 1000
    });
    const nextState = harness.store.load();

    expect(nextState.workers["R-01"]?.status).toBe("completed");
    expect(nextState.workers["R-02"]?.status).toBe("abandoned");
    expect(nextState.workers["R-03"]?.status).toBe("failed");
    expect(nextState.workers["R-04"]?.status).toBe("completed");
    expect(sendRequest).toHaveBeenCalledTimes(3);
    expect(sendRequest.mock.calls.map(([message]) => (message as HubMessage).thread_id)).toEqual([
      "worker-thread-111",
      "worker-thread-222",
      "worker-thread-333"
    ]);
    expect(report).toEqual({
      changed: [
        {
          workerId: "R-01",
          from: "running",
          to: "completed",
          trigger: "hub_status:completed:outputs_present"
        },
        {
          workerId: "R-02",
          from: "running",
          to: "abandoned",
          trigger: "thread_missing:stale_timeout"
        },
        {
          workerId: "R-03",
          from: "running",
          to: "failed",
          trigger: "hub_status:error"
        }
      ],
      unchanged: [DISPATCHER_ENTRY_ID, "R-04"]
    });
  });

  it("uses the default stale timeout when no override is provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));

    const harness = await createHarness();
    harness.store.save(buildState({
      workers: {
        "N-02": buildRunningWorker(
          "worker-thread-111",
          path.join(harness.directory, "missing-report.md"),
          "2026-04-03T11:59:59.000Z"
        )
      }
    }));

    const { hubClient } = createHubClient((message) => buildMissingThreadResult(message.thread_id));

    await reconcile(harness.store, hubClient);

    expect(Date.parse(FIXED_NOW) - Date.parse("2026-04-03T11:59:59.000Z")).toBeGreaterThan(
      DEFAULT_RECONCILE_STALE_TIMEOUT_MS
    );
    expect(harness.store.load().workers["N-02"]?.status).toBe("abandoned");
  });
});

async function createHarness() {
  const directory = await fsp.mkdtemp(path.join(tmpdir(), "reconciler-test-"));
  tempDirectories.add(directory);

  const filePath = path.join(directory, "dispatch_threads.json");
  const store = new LifecycleStore(filePath);

  return {
    directory,
    filePath,
    store,
    async writeOutput(relativePath: string, content = "done\n"): Promise<string> {
      const outputPath = path.join(directory, relativePath);
      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      await fsp.writeFile(outputPath, content, "utf8");
      return outputPath;
    }
  };
}

function createHubClient(
  resolver: (message: HubMessage) => HubResult | Promise<HubResult>
): {
  hubClient: A2AClient;
  sendRequest: ReturnType<typeof vi.fn<(message: HubMessage) => Promise<HubResult>>>;
} {
  const sendRequest = vi.fn(async (message: HubMessage) => await resolver(message));

  return {
    hubClient: {
      serviceId: "service:meridian-roles",
      sendRequest
    } as unknown as A2AClient,
    sendRequest
  };
}

function buildState(partial: Partial<DispatchThreadStateV2>): DispatchThreadStateV2 {
  const base = buildEmptyDispatchThreadStateV2();

  return {
    ...base,
    ...partial,
    dispatcher: {
      ...base.dispatcher,
      ...partial.dispatcher
    },
    workers: partial.workers ?? base.workers,
    last_reconciled_at: partial.last_reconciled_at ?? base.last_reconciled_at
  };
}

function buildRunningWorker(
  threadId: string,
  expectedOutput: string,
  startedAt = "2026-04-03T12:20:00.000Z"
): DispatchThreadStateV2["workers"][string] {
  return {
    thread_id: threadId,
    trace_id: "11111111-1111-4111-8111-111111111111",
    started_at: startedAt,
    last_seen_at: startedAt,
    status: "running",
    expected_outputs: [expectedOutput],
    hub_result: null,
    command_preamble: null
  };
}

function buildStatusResult(threadId: string, status: string): HubResult {
  return {
    trace_id: "11111111-1111-4111-8111-111111111111",
    thread_id: threadId,
    source: "codex",
    status: "success",
    content: JSON.stringify({
      instance: {
        thread_id: threadId,
        status
      },
      agent_status: {
        status
      }
    }),
    attachments: [],
    timestamp: FIXED_NOW
  };
}

function buildTerminalSuccessResult(threadId: string): HubResult {
  return {
    trace_id: "11111111-1111-4111-8111-111111111111",
    thread_id: threadId,
    source: "codex",
    status: "success",
    run_state: "completed",
    content: "worker finished",
    attachments: [],
    timestamp: FIXED_NOW
  };
}

function buildMissingThreadResult(threadId: string): HubResult {
  return {
    trace_id: "22222222-2222-4222-8222-222222222222",
    thread_id: threadId,
    source: "codex",
    status: "error",
    content: `Routing failed: Cannot fetch status; thread_id=${threadId} is not registered`,
    attachments: [],
    timestamp: FIXED_NOW
  };
}
