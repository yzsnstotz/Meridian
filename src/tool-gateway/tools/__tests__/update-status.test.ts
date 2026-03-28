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
