import * as fs from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import dispatchStatusTool from "../dispatch-status";

const tempDirectories = new Set<string>();

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("dispatch-status tool", () => {
  it("marks running workers as stale from dispatch_threads.json last_seen_at", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T01:00:00.000Z"));

    const directory = await fs.mkdtemp("/tmp/meridian-roles-dispatch-status-");
    tempDirectories.add(directory);
    const planPath = `${directory}/dispatch_plan.md`;
    const sidecarPath = `${directory}/dispatch_threads.json`;

    await fs.writeFile(
      planPath,
      [
        "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
        "|--------|-------|--------|------|-------|------------|----------------|-------|",
        "| 🔄 | 2 | N-05 | Dispatch status | CODEX-HIGH | R-03 | CLI Integration PRD | read-only |",
        "| ✅ | 1 | R-03 | Bin registration | CODEX | — | CLI Integration PRD | complete |",
        ""
      ].join("\n"),
      "utf8"
    );

    await fs.writeFile(
      sidecarPath,
      `${JSON.stringify({
        version: 2,
        dispatcher: {
          thread_id: "dispatcher-thread-123",
          started_at: "2026-04-05T00:00:00.000Z",
          status: "running"
        },
        workers: {
          "N-05": {
            thread_id: "worker-thread-456",
            trace_id: null,
            started_at: "2026-04-05T00:00:00.000Z",
            last_seen_at: "2026-04-05T00:10:00.000Z",
            status: "running",
            expected_outputs: [],
            hub_result: null
          }
        },
        last_reconciled_at: null
      }, null, 2)}\n`,
      "utf8"
    );

    const result = await dispatchStatusTool.execute({
      plan: planPath
    });

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        plan: planPath,
        dispatch_threads: sidecarPath,
        stale_threshold_minutes: 30,
        summary: {
          total: 2,
          pending: 0,
          running: 1,
          completed: 1,
          failed: 0,
          skipped: 0,
          stale: 1
        },
        workers: [
          expect.objectContaining({
            worker_id: "N-05",
            status: "🔄",
            stale: true,
            stale_label: "⚠️ STALE",
            stale_duration_minutes: 50,
            stale_duration_human: "50m",
            thread_id: "worker-thread-456",
            last_seen_at: "2026-04-05T00:10:00.000Z"
          }),
          expect.objectContaining({
            worker_id: "R-03",
            status: "✅",
            stale: false
          })
        ]
      })
    });
  });
});
