import * as fs from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import updateStatusTool, { updateWorkerStatusInMarkdown } from "../update-status";

const tempDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("update-status tool", () => {
  it("updates the worker status inside a markdown table with variable whitespace", () => {
    const markdown = [
      "# Plan",
      "",
      "| Status | Batch | Worker | Task |",
      "|--------|-------|--------|------|",
      "|   ⬜   | 2 | N-05 | Tools |",
      "| ✅ | 2 | N-04 | Run |",
      ""
    ].join("\n");

    const updated = updateWorkerStatusInMarkdown(markdown, "N-05", "in_progress");

    expect(updated).toContain("| 🔄 | 2 | N-05 | Tools |");
    expect(updated).toContain("| ✅ | 2 | N-04 | Run |");
  });

  it("updates markdown tables that use lowercase status and worker headers", () => {
    const markdown = [
      "# Plan",
      "",
      "| status | batch | worker | task |",
      "|--------|-------|--------|------|",
      "| ⬜ | 2 | N-05 | Tools |",
      ""
    ].join("\n");

    const updated = updateWorkerStatusInMarkdown(markdown, "N-05", "done");

    expect(updated).toContain("| ✅ | 2 | N-05 | Tools |");
  });

  it("writes the updated markdown back to disk", async () => {
    const directory = await fs.mkdtemp("/tmp/meridian-roles-update-status-");
    tempDirectories.add(directory);
    const planPath = `${directory}/dispatch_plan.md`;

    await fs.writeFile(
      planPath,
      [
        "| Status | Batch | Worker | Task |",
        "|--------|-------|--------|------|",
        "| 🔄 | 2 | N-05 | Tools |",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await updateStatusTool.execute({
      plan: planPath,
      worker: "N-05",
      status: "done"
    });

    expect(result).toEqual({
      ok: true,
      data: {
        worker: "N-05",
        status: "done"
      }
    });
    await expect(fs.readFile(planPath, "utf8")).resolves.toContain("| ✅ | 2 | N-05 | Tools |");
  });

  it("records the worker thread id in the sidecar when marking a worker in progress", async () => {
    const directory = await fs.mkdtemp("/tmp/meridian-roles-update-status-");
    tempDirectories.add(directory);
    const planPath = `${directory}/dispatch_plan.md`;
    const sidecarPath = `${directory}/dispatch_threads.json`;

    await fs.writeFile(
      planPath,
      [
        "| Status | Batch | Worker | Task |",
        "|--------|-------|--------|------|",
        "| ⬜ | 2 | N-05 | Tools |",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await updateStatusTool.execute({
      plan: planPath,
      worker: "N-05",
      status: "in_progress",
      thread_id: "worker-thread-456"
    });

    expect(result).toEqual({
      ok: true,
      data: {
        worker: "N-05",
        status: "in_progress"
      }
    });
    await expect(fs.readFile(planPath, "utf8")).resolves.toContain("| 🔄 | 2 | N-05 | Tools |");

    const sidecar = JSON.parse(await fs.readFile(sidecarPath, "utf8")) as {
      version: number;
      dispatcher: { thread_id: string | null; status: string };
      workers: Record<string, { thread_id: string; started_at: string; status: string }>;
    };
    expect(sidecar.version).toBe(2);
    expect(sidecar.dispatcher).toMatchObject({
      thread_id: null,
      status: "pending"
    });
    expect(sidecar.workers["N-05"]).toMatchObject({
      thread_id: "worker-thread-456",
      status: "running"
    });
    expect(sidecar.workers["N-05"]?.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("stores model and reasoning effort overrides in the sidecar when updating worker status", async () => {
    const directory = await fs.mkdtemp("/tmp/meridian-roles-update-status-");
    tempDirectories.add(directory);
    const planPath = `${directory}/dispatch_plan.md`;
    const sidecarPath = `${directory}/dispatch_threads.json`;

    await fs.writeFile(
      planPath,
      [
        "| Status | Batch | Worker | Task |",
        "|--------|-------|--------|------|",
        "| ⬜ | 2 | N-05 | Tools |",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await updateStatusTool.execute({
      plan: planPath,
      worker: "N-05",
      status: "in_progress",
      thread_id: "worker-thread-456",
      model: "gpt-5.5",
      reasoning_effort: "high"
    });

    expect(result).toEqual({
      ok: true,
      data: {
        worker: "N-05",
        status: "in_progress"
      }
    });

    const sidecar = JSON.parse(await fs.readFile(sidecarPath, "utf8")) as {
      version: number;
      workers: Record<
        string,
        { applied_model_id?: string; applied_reasoning_effort?: string; status: string; thread_id: string }
      >;
    };

    expect(sidecar.version).toBe(2);
    expect(sidecar.workers["N-05"]).toMatchObject({
      status: "running",
      thread_id: "worker-thread-456",
      applied_model_id: "gpt-5.5",
      applied_reasoning_effort: "high"
    });
  });

  it("marks a worker completed in the lifecycle sidecar when the worker reaches a terminal state", async () => {
    const directory = await fs.mkdtemp("/tmp/meridian-roles-update-status-");
    tempDirectories.add(directory);
    const planPath = `${directory}/dispatch_plan.md`;
    const sidecarPath = `${directory}/dispatch_threads.json`;

    await fs.writeFile(
      planPath,
      [
        "| Status | Batch | Worker | Task |",
        "|--------|-------|--------|------|",
        "| 🔄 | 2 | N-05 | Tools |",
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
          started_at: "2026-03-28T11:59:00.000Z",
          status: "running"
        },
        workers: {
          "N-05": {
            thread_id: "worker-thread-456",
            trace_id: null,
            started_at: "2026-03-28T12:00:00.000Z",
            last_seen_at: "2026-03-28T12:00:00.000Z",
            status: "running",
            expected_outputs: [],
            hub_result: null
          }
        },
        last_reconciled_at: null
      }, null, 2)}\n`,
      "utf8"
    );

    const result = await updateStatusTool.execute({
      plan: planPath,
      worker: "N-05",
      status: "done"
    });

    expect(result).toEqual({
      ok: true,
      data: {
        worker: "N-05",
        status: "done"
      }
    });
    await expect(fs.readFile(planPath, "utf8")).resolves.toContain("| ✅ | 2 | N-05 | Tools |");

    await expect(fs.readFile(sidecarPath, "utf8")).resolves.toSatisfy((raw) => {
      const sidecar = JSON.parse(raw) as {
        dispatcher: { thread_id: string | null; status: string };
        workers: Record<string, { thread_id: string; status: string }>;
      };

      return sidecar.dispatcher.thread_id === "dispatcher-thread-123"
        && sidecar.dispatcher.status === "running"
        && sidecar.workers["N-05"]?.thread_id === "worker-thread-456"
        && sidecar.workers["N-05"]?.status === "completed";
    });
  });

  it("resets a completed worker to pending even when the plan already shows ✅", async () => {
    const directory = await fs.mkdtemp("/tmp/meridian-roles-update-status-");
    tempDirectories.add(directory);
    const planPath = `${directory}/dispatch_plan.md`;
    const sidecarPath = `${directory}/dispatch_threads.json`;

    await fs.writeFile(
      planPath,
      [
        "| Status | Batch | Worker | Task |",
        "|--------|-------|--------|------|",
        "| ✅ | 1 | R-01 | OAuth fix |",
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
          "R-01": {
            thread_id: "worker-thread-789",
            trace_id: null,
            started_at: "2026-04-05T00:00:00.000Z",
            last_seen_at: "2026-04-05T00:10:00.000Z",
            status: "completed",
            expected_outputs: [],
            hub_result: null,
            command_preamble: null,
            retry_count: 0
          }
        },
        last_reconciled_at: null
      }, null, 2)}\n`,
      "utf8"
    );

    const result = await updateStatusTool.execute({
      plan: planPath,
      worker: "R-01",
      status: "pending"
    });

    expect(result).toEqual({ ok: true, data: { worker: "R-01", status: "pending" } });
    await expect(fs.readFile(planPath, "utf8")).resolves.toContain("| ⬜ | 1 | R-01 | OAuth fix |");
  });

  it("returns an error for unsupported statuses", async () => {
    const result = await updateStatusTool.execute({
      plan: "/tmp/nowhere.md",
      worker: "N-05",
      status: "paused"
    });

    expect(result).toEqual({
      ok: false,
      error: "Unsupported status: paused"
    });
  });
});
