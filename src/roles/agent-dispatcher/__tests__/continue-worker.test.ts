import * as fsPromises from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { extractRepoFieldFromWorkerFile, resolveWorkerSpawnDir } from "../continue-worker";

const tempDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirectories, async (directory) => {
      await fsPromises.rm(directory, { recursive: true, force: true });
    })
  );
  tempDirectories.clear();
});

describe("extractRepoFieldFromWorkerFile", () => {
  it("extracts repo path from standard worker file format", () => {
    const content = [
      "### N-06 — ADS Meridian Integration Client",
      "",
      "- **Repo**: `/Users/work/projects/ADS`",
      "- **Runtime**: Node.js + TypeScript",
    ].join("\n");

    expect(extractRepoFieldFromWorkerFile(content)).toBe("/Users/work/projects/ADS");
  });

  it("extracts repo path without backticks", () => {
    const content = "- **Repo**: /Users/work/meridian\n- **Runtime**: Node.js";

    expect(extractRepoFieldFromWorkerFile(content)).toBe("/Users/work/meridian");
  });

  it("extracts repo path with asterisk bullet and no bold", () => {
    const content = "* Repo: /tmp/my-repo\n* Runtime: Node.js";

    expect(extractRepoFieldFromWorkerFile(content)).toBe("/tmp/my-repo");
  });

  it("prefers an inline absolute repo path over the display alias", () => {
    const content = "- **Repo**: `github-ai-automation-scan` (`/Users/work/github-ai-automation-scan`)";

    expect(extractRepoFieldFromWorkerFile(content)).toBe("/Users/work/github-ai-automation-scan");
  });

  it("strips read-only qualifier text from repo aliases", () => {
    const content = "- **Repo**: both (read-only — no code changes, no branch creation)";

    expect(extractRepoFieldFromWorkerFile(content)).toBe("both");
  });

  it("returns null when no Repo field exists", () => {
    const content = "### N-01 — Init\n\n- **Runtime**: Node.js";

    expect(extractRepoFieldFromWorkerFile(content)).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(extractRepoFieldFromWorkerFile("")).toBeNull();
  });
});

describe("resolveWorkerSpawnDir", () => {
  async function createTempPlan(workerFiles: Record<string, string>): Promise<string> {
    const dir = await fsPromises.mkdtemp(path.join(tmpdir(), "spawn-dir-test-"));
    tempDirectories.add(dir);

    const planPath = path.join(dir, "dispatch_plan.md");
    await fsPromises.writeFile(planPath, [
      "# Plan",
      "",
      "## Repo Map",
      "",
      "| Prefix | Repo | Path | Base Branch |",
      "|--------|------|------|-------------|",
      "| `T-*` | `github-ai-automation-scan` | `/Users/work/github-ai-automation-scan` | `main` |",
      "| `M-*` | `Meridian-roles` | `/Users/work/Meridian/Meridian-roles` | `main` |",
      "| `PRE-FLIGHT`, `*-GATE` | both (read-only) | n/a | n/a |",
      ""
    ].join("\n"), "utf8");

    for (const [workerId, content] of Object.entries(workerFiles)) {
      await fsPromises.writeFile(path.join(dir, `${workerId}.md`), content, "utf8");
    }

    return planPath;
  }

  it("returns repo path from worker file when present", async () => {
    const planPath = await createTempPlan({
      "N-06": "- **Repo**: `/Users/work/projects/ADS`\n- **Runtime**: Node.js"
    });

    expect(resolveWorkerSpawnDir(planPath, "N-06")).toBe("/Users/work/projects/ADS");
  });

  it("returns null when worker file does not exist", async () => {
    const planPath = await createTempPlan({});

    expect(resolveWorkerSpawnDir(planPath, "N-99")).toBeNull();
  });

  it("returns null when worker file has no Repo field", async () => {
    const planPath = await createTempPlan({
      "R-01": "### R-01\n\n- **Runtime**: Node.js"
    });

    expect(resolveWorkerSpawnDir(planPath, "R-01")).toBeNull();
  });

  it("resolves different repos for different workers", async () => {
    const planPath = await createTempPlan({
      "N-06": "- **Repo**: `/Users/work/projects/ADS`",
      "R-01": "- **Repo**: `/Users/work/meridian`"
    });

    expect(resolveWorkerSpawnDir(planPath, "N-06")).toBe("/Users/work/projects/ADS");
    expect(resolveWorkerSpawnDir(planPath, "R-01")).toBe("/Users/work/meridian");
  });

  it("resolves repo aliases through the dispatch plan repo map", async () => {
    const planPath = await createTempPlan({
      "T-DB-SCHEMA": "- **Repo**: `github-ai-automation-scan`\n- **Runtime**: Python",
      "M-SCHEDULER-WIRE": "- **Repo**: `Meridian-roles`\n- **Runtime**: TypeScript"
    });

    expect(resolveWorkerSpawnDir(planPath, "T-DB-SCHEMA")).toBe("/Users/work/github-ai-automation-scan");
    expect(resolveWorkerSpawnDir(planPath, "M-SCHEDULER-WIRE")).toBe("/Users/work/Meridian/Meridian-roles");
  });

  it("does not resolve read-only both repo aliases as literal directories", async () => {
    const planPath = await createTempPlan({
      "PRE-FLIGHT": "- **Repo**: both (read-only — no code changes, no branch creation)"
    });

    expect(resolveWorkerSpawnDir(planPath, "PRE-FLIGHT")).toBeNull();
  });
});
