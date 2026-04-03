import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DispatchThreadStateV2, HubResult } from "../../../types";
import { LifecycleStore, buildEmptyDispatchThreadStateV2 } from "../lifecycle-store";

const tempDirectories = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();

  await Promise.all(
    Array.from(tempDirectories, async (directory) => {
      await fsp.rm(directory, { recursive: true, force: true });
    })
  );

  tempDirectories.clear();
});

describe("LifecycleStore", () => {
  it("loads an empty file as an empty v2 lifecycle state", async () => {
    const harness = await createHarness();
    await fsp.writeFile(harness.filePath, "", "utf8");

    const state = harness.store.load();

    expect(state).toEqual(buildEmptyDispatchThreadStateV2());
    await expect(fsp.readFile(harness.filePath, "utf8")).resolves.toContain("\"version\": 2");
  });

  it("auto-migrates a v1 sidecar file to v2 defaults", async () => {
    const harness = await createHarness();
    await fsp.writeFile(harness.filePath, `${JSON.stringify({
      dispatcher_thread_id: "dispatcher-thread-123",
      workers: {
        "N-01": "worker-thread-111",
        "N-02": {
          thread_id: "worker-thread-222",
          started_at: "2026-04-02T17:21:55.063Z"
        }
      }
    }, null, 2)}\n`, "utf8");

    const state = harness.store.load();

    expect(state).toEqual({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "1970-01-01T00:00:00.000Z",
        status: "running"
      },
      workers: {
        "N-01": {
          thread_id: "worker-thread-111",
          trace_id: null,
          started_at: "1970-01-01T00:00:00.000Z",
          last_seen_at: "1970-01-01T00:00:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null
        },
        "N-02": {
          thread_id: "worker-thread-222",
          trace_id: null,
          started_at: "2026-04-02T17:21:55.063Z",
          last_seen_at: "2026-04-02T17:21:55.063Z",
          status: "running",
          expected_outputs: [],
          hub_result: null
        }
      },
      last_reconciled_at: null
    });

    const saved = JSON.parse(await fsp.readFile(harness.filePath, "utf8")) as DispatchThreadStateV2;
    expect(saved.version).toBe(2);
    expect(saved.workers["N-01"]?.trace_id).toBeNull();
    expect(saved.workers["N-02"]?.expected_outputs).toEqual([]);
  });

  it("records worker start state as running", async () => {
    const harness = await createHarness();

    harness.store.recordWorkerStart("N-01", "worker-thread-111", "11111111-1111-4111-8111-111111111111", [
      "test/gui-demo/final.txt"
    ]);

    const state = harness.store.load();
    expect(state.workers["N-01"]).toMatchObject({
      thread_id: "worker-thread-111",
      trace_id: "11111111-1111-4111-8111-111111111111",
      status: "running",
      expected_outputs: ["test/gui-demo/final.txt"],
      hub_result: null
    });
    expect(state.workers["N-01"]?.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(state.workers["N-01"]?.last_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("maps a success HubResult to completed", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("N-01", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("N-01", buildHubResult({
      thread_id: "worker-thread-111",
      status: "success",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["N-01"]).toMatchObject({
      status: "completed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("maps an error HubResult to failed", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("N-01", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.recordWorkerResult("N-01", buildHubResult({
      thread_id: "worker-thread-111",
      status: "error",
      content: "worker failed",
      timestamp: "2026-04-03T12:00:00.000Z"
    }));

    expect(harness.store.load().workers["N-01"]).toMatchObject({
      status: "failed",
      last_seen_at: "2026-04-03T12:00:00.000Z"
    });
  });

  it("marks workers as abandoned", async () => {
    const harness = await createHarness();
    harness.store.recordWorkerStart("N-01", "worker-thread-111", "11111111-1111-4111-8111-111111111111", []);

    harness.store.markAbandoned("N-01", "thread missing after restart");

    expect(harness.store.load().workers["N-01"]?.status).toBe("abandoned");
  });

  it("returns only workers in the requested lifecycle state", async () => {
    const harness = await createHarness();
    harness.store.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-03T11:59:00.000Z",
        status: "running"
      },
      workers: {
        "N-01": {
          thread_id: "worker-thread-111",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null
        },
        "N-02": {
          thread_id: "worker-thread-222",
          trace_id: null,
          started_at: "2026-04-03T12:01:00.000Z",
          last_seen_at: "2026-04-03T12:01:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: buildHubResult({
            thread_id: "worker-thread-222",
            status: "success",
            timestamp: "2026-04-03T12:01:10.000Z"
          })
        },
        "N-03": {
          thread_id: "worker-thread-333",
          trace_id: null,
          started_at: "2026-04-03T12:02:00.000Z",
          last_seen_at: "2026-04-03T12:02:00.000Z",
          status: "running",
          expected_outputs: ["test/gui-demo/final.txt"],
          hub_result: null
        }
      },
      last_reconciled_at: null
    });

    const runningWorkers = harness.store.getWorkersInState("running");

    expect(runningWorkers.map((worker) => worker.worker_id)).toEqual(["N-01", "N-03"]);
    expect(runningWorkers[1]?.expected_outputs).toEqual(["test/gui-demo/final.txt"]);
  });

  it("never exposes partial JSON at the target file path during atomic writes", async () => {
    const harness = await createHarness();
    const priorState = buildEmptyDispatchThreadStateV2();
    harness.store.save(priorState);

    const nextState: DispatchThreadStateV2 = {
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-03T11:59:00.000Z",
        status: "running"
      },
      workers: {
        "N-01": {
          thread_id: "worker-thread-111",
          trace_id: "11111111-1111-4111-8111-111111111111",
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "running",
          expected_outputs: ["test/gui-demo/final.txt"],
          hub_result: null
        }
      },
      last_reconciled_at: null
    };

    const observedStates: unknown[] = [];
    const hookedStore = new LifecycleStore(harness.filePath, {
      beforeCommit: (tempFilePath, targetFilePath) => {
        expect(fs.existsSync(tempFilePath)).toBe(true);

        const duringWrite = fs.readFileSync(targetFilePath, "utf8");
        expect(() => JSON.parse(duringWrite)).not.toThrow();
        observedStates.push(JSON.parse(duringWrite));
      }
    });

    hookedStore.save(nextState);

    expect(harness.store.load()).toEqual(nextState);
    expect(observedStates).toEqual([priorState]);
  });

  it("renders plan markdown using lifecycle status symbols", async () => {
    const harness = await createHarness();
    harness.store.save({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-123",
        started_at: "2026-04-03T11:59:00.000Z",
        status: "running"
      },
      workers: {
        "N-01": {
          thread_id: "worker-thread-111",
          trace_id: null,
          started_at: "2026-04-03T12:00:00.000Z",
          last_seen_at: "2026-04-03T12:00:00.000Z",
          status: "pending",
          expected_outputs: [],
          hub_result: null
        },
        "N-02": {
          thread_id: "worker-thread-222",
          trace_id: null,
          started_at: "2026-04-03T12:01:00.000Z",
          last_seen_at: "2026-04-03T12:01:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null
        },
        "N-03": {
          thread_id: "worker-thread-333",
          trace_id: null,
          started_at: "2026-04-03T12:02:00.000Z",
          last_seen_at: "2026-04-03T12:02:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: buildHubResult({
            thread_id: "worker-thread-333",
            status: "success",
            timestamp: "2026-04-03T12:02:10.000Z"
          })
        },
        "N-04": {
          thread_id: "worker-thread-444",
          trace_id: null,
          started_at: "2026-04-03T12:03:00.000Z",
          last_seen_at: "2026-04-03T12:03:00.000Z",
          status: "failed",
          expected_outputs: [],
          hub_result: buildHubResult({
            thread_id: "worker-thread-444",
            status: "error",
            content: "worker failed",
            timestamp: "2026-04-03T12:03:10.000Z"
          })
        },
        "N-05": {
          thread_id: "worker-thread-555",
          trace_id: null,
          started_at: "2026-04-03T12:04:00.000Z",
          last_seen_at: "2026-04-03T12:04:00.000Z",
          status: "abandoned",
          expected_outputs: [],
          hub_result: null
        }
      },
      last_reconciled_at: null
    });

    const markdown = harness.store.toPlanMarkdown([
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task |",
      "|--------|-------|--------|------|",
      "| ⬜ | 1 | N-01 | Pending row |",
      "| ⬜ | 1 | N-02 | Running row |",
      "| ⬜ | 1 | N-03 | Completed row |",
      "| ⬜ | 1 | N-04 | Failed row |",
      "| ⬜ | 1 | N-05 | Abandoned row |",
      ""
    ].join("\n"));

    expect(markdown).toContain("| ⬜ | 1 | N-01 | Pending row |");
    expect(markdown).toContain("| 🔄 | 1 | N-02 | Running row |");
    expect(markdown).toContain("| ✅ | 1 | N-03 | Completed row |");
    expect(markdown).toContain("| ❌ | 1 | N-04 | Failed row |");
    expect(markdown).toContain("| ❌ | 1 | N-05 | Abandoned row |");
  });
});

async function createHarness(): Promise<{
  directory: string;
  filePath: string;
  store: LifecycleStore;
}> {
  const directory = await fsp.mkdtemp(path.join(tmpdir(), "meridian-roles-lifecycle-store-"));
  tempDirectories.add(directory);

  const filePath = path.join(directory, "dispatch_threads.json");

  return {
    directory,
    filePath,
    store: new LifecycleStore(filePath)
  };
}

function buildHubResult(overrides: Partial<HubResult> = {}): HubResult {
  return {
    trace_id: overrides.trace_id ?? "11111111-1111-4111-8111-111111111111",
    thread_id: overrides.thread_id ?? "worker-thread-111",
    source: overrides.source ?? "codex",
    status: overrides.status ?? "success",
    run_state: overrides.run_state,
    content: overrides.content ?? "worker finished",
    summary_text: overrides.summary_text,
    details_text: overrides.details_text,
    attachments: overrides.attachments ?? [],
    timestamp: overrides.timestamp ?? "2026-04-03T12:00:00.000Z"
  };
}
