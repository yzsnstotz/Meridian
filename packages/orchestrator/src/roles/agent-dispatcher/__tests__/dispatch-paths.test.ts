import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveConfiguredDocsRoot, resolveDispatchRepoRoot } from "../dispatch-paths";

const tempDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirectories, async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    })
  );
  tempDirectories.clear();
});

describe("resolveDispatchRepoRoot", () => {
  it("walks up to the nearest git root when dispatch docs live inside a repo", async () => {
    const repoRoot = await fs.mkdtemp(path.join(tmpdir(), "dispatch-paths-repo-"));
    tempDirectories.add(repoRoot);
    await fs.mkdir(path.join(repoRoot, ".git"));

    const dispatchPlanPath = path.join(repoRoot, "docs/branch/feat-test/dispatch_plan.md");
    await fs.mkdir(path.dirname(dispatchPlanPath), { recursive: true });
    await fs.writeFile(dispatchPlanPath, "# plan\n", "utf8");

    expect(resolveDispatchRepoRoot([dispatchPlanPath])).toBe(repoRoot);
  });

  it("prefers detached Docs/Projects mapping over an enclosing workspace git root", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(tmpdir(), "dispatch-paths-workspace-"));
    tempDirectories.add(workspaceRoot);
    await fs.mkdir(path.join(workspaceRoot, ".git"));

    const repoRoot = path.join(workspaceRoot, "projects/clawso");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    const canonicalRepoRoot = await fs.realpath(repoRoot);

    const dispatchPlanPath = path.join(
      workspaceRoot,
      "Docs/Projects/clawso/branch/feat-cli/taskspec/dispatch_plan.md"
    );
    await fs.mkdir(path.dirname(dispatchPlanPath), { recursive: true });
    await fs.writeFile(dispatchPlanPath, "# plan\n", "utf8");
    const canonicalDocsRoot = await fs.realpath(path.join(workspaceRoot, "Docs"));

    expect(resolveDispatchRepoRoot([dispatchPlanPath])).toBe(canonicalRepoRoot);
    expect(resolveConfiguredDocsRoot({
      dispatch_plan_path: dispatchPlanPath
    })).toBe(canonicalDocsRoot);
  });

  it("maps detached Docs/Project dispatch artifacts back to the real repo root", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(tmpdir(), "dispatch-paths-workspace-"));
    tempDirectories.add(workspaceRoot);

    const repoRoot = path.join(workspaceRoot, "Projects/meridian");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    const canonicalRepoRoot = await fs.realpath(repoRoot);

    const dispatchPlanPath = path.join(
      workspaceRoot,
      "Docs/Project/meridian/branch/feat-routing/taskspec/dispatch_plan.md"
    );
    await fs.mkdir(path.dirname(dispatchPlanPath), { recursive: true });
    await fs.writeFile(dispatchPlanPath, "# plan\n", "utf8");

    expect(resolveDispatchRepoRoot([dispatchPlanPath])).toBe(canonicalRepoRoot);
  });

  it("falls back to the dispatch artifact directory when no git root exists", async () => {
    const dispatchDirectory = await fs.mkdtemp(path.join(tmpdir(), "dispatch-paths-dir-"));
    tempDirectories.add(dispatchDirectory);
    const dispatchPlanPath = path.join(dispatchDirectory, "dispatch_plan.md");
    await fs.writeFile(dispatchPlanPath, "# plan\n", "utf8");

    expect(resolveDispatchRepoRoot([dispatchPlanPath])).toBe(dispatchDirectory);
  });
});
