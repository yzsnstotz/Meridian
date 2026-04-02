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
      dispatcher_thread_id: string | null;
      workers: Record<string, { thread_id: string; started_at: string }>;
    };
    expect(sidecar.dispatcher_thread_id).toBeNull();
    expect(sidecar.workers["N-05"]).toMatchObject({
      thread_id: "worker-thread-456"
    });
    expect(sidecar.workers["N-05"]?.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("removes a worker sidecar entry when the worker reaches a terminal state", async () => {
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
        dispatcher_thread_id: "dispatcher-thread-123",
        workers: {
          "N-05": {
            thread_id: "worker-thread-456",
            started_at: "2026-03-28T12:00:00.000Z"
          }
        }
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

    await expect(fs.readFile(sidecarPath, "utf8")).resolves.toEqual(`${JSON.stringify({
      dispatcher_thread_id: "dispatcher-thread-123",
      workers: {}
    }, null, 2)}\n`);
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
