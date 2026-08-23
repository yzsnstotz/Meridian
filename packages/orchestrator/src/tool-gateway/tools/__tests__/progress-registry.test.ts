import * as fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchProgressFromSource,
  loadProgressRegistryForPlan,
  resolveProgressSource
} from "../progress-registry";

const tempDirectories = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

async function makeRoutineJobLayout(): Promise<{ root: string; planPath: string }> {
  const root = await fs.mkdtemp("/tmp/meridian-roles-progress-registry-");
  tempDirectories.add(root);
  const jobDir = path.join(root, "github-opc-solution-scan", "v1");
  await fs.mkdir(jobDir, { recursive: true });
  const planPath = path.join(jobDir, "dispatch_plan.md");
  await fs.writeFile(planPath, "# Dispatch Plan\n", "utf8");
  return { root, planPath };
}

describe("progress-registry", () => {
  it("returns null when no registry file exists in any ancestor", async () => {
    const { planPath } = await makeRoutineJobLayout();
    const registry = await loadProgressRegistryForPlan(planPath);
    expect(registry).toBeNull();
  });

  it("walks up to find progress_registry.json next to multiple routine-jobs", async () => {
    const { root, planPath } = await makeRoutineJobLayout();

    await fs.writeFile(
      path.join(root, "progress_registry.json"),
      JSON.stringify({
        version: 1,
        routine_jobs: [
          {
            name: "github-opc-solution-scan",
            plan_path_prefix: path.join(root, "github-opc-solution-scan"),
            default_source: { kind: "http", url: "http://localhost:9105/api/workers/{worker_id}" }
          }
        ]
      }),
      "utf8"
    );

    const registry = await loadProgressRegistryForPlan(planPath);
    expect(registry).not.toBeNull();
    expect(registry?.routine_jobs[0]?.name).toBe("github-opc-solution-scan");
  });

  it("rejects malformed registry payloads", async () => {
    const { root, planPath } = await makeRoutineJobLayout();
    await fs.writeFile(path.join(root, "progress_registry.json"), JSON.stringify({ version: 2 }), "utf8");

    const registry = await loadProgressRegistryForPlan(planPath);
    expect(registry).toBeNull();
  });

  it("matches the longest plan_path_prefix and prefers per-worker overrides", () => {
    const registry = {
      version: 1 as const,
      routine_jobs: [
        {
          name: "outer",
          plan_path_prefix: "/tmp/jobs",
          default_source: { kind: "http" as const, url: "http://outer/{worker_id}" }
        },
        {
          name: "inner",
          plan_path_prefix: "/tmp/jobs/github-opc",
          default_source: { kind: "http" as const, url: "http://inner/{worker_id}" },
          workers: { "T-REPO-FETCH": { kind: "http" as const, url: "http://override/repo" } }
        }
      ]
    };

    const generic = resolveProgressSource(registry, "/tmp/jobs/github-opc/plan.md", "T-OTHER");
    expect(generic?.routineJob).toBe("inner");
    expect(generic?.source).toEqual({ kind: "http", url: "http://inner/{worker_id}" });

    const override = resolveProgressSource(registry, "/tmp/jobs/github-opc/plan.md", "T-REPO-FETCH");
    expect(override?.source).toEqual({ kind: "http", url: "http://override/repo" });

    const outerMatch = resolveProgressSource(registry, "/tmp/jobs/legacy/plan.md", "T-X");
    expect(outerMatch?.routineJob).toBe("outer");
  });

  it("returns null when no routine-job prefix matches", () => {
    const registry = {
      version: 1 as const,
      routine_jobs: [
        {
          name: "only",
          plan_path_prefix: "/tmp/somewhere-else",
          default_source: { kind: "http" as const, url: "http://x/{worker_id}" }
        }
      ]
    };
    expect(resolveProgressSource(registry, "/tmp/jobs/plan.md", "T-X")).toBeNull();
  });

  it("reads progress from a file source and substitutes {worker_id}/{scan_run_id}", async () => {
    const directory = await fs.mkdtemp("/tmp/meridian-roles-progress-registry-file-");
    tempDirectories.add(directory);

    const progressPath = path.join(directory, "T-REPO-FETCH-daily-2026-04-28.progress.json");
    await fs.writeFile(progressPath, JSON.stringify({
      command: "repo-fetch",
      status: "running",
      total: 100,
      processed: 47,
      success: 40,
      failed: 2,
      skipped: 5,
      remaining: 53,
      updated_at: "2026-04-28T00:00:00.000Z",
      extra: { current_repo: "octocat/Hello-World" }
    }), "utf8");

    const result = await fetchProgressFromSource(
      {
        routineJob: "github-opc-solution-scan",
        source: {
          kind: "file",
          path: path.join(directory, "{worker_id}-{scan_run_id}.progress.json")
        }
      },
      "T-REPO-FETCH",
      "daily-2026-04-28"
    );

    expect(result).toMatchObject({
      command: "repo-fetch",
      status: "running",
      processed: 47,
      remaining: 53,
      extra: { current_repo: "octocat/Hello-World" },
      progress_path: progressPath
    });
  });

  it("falls back to worker_id as command when payload omits it", async () => {
    const directory = await fs.mkdtemp("/tmp/meridian-roles-progress-registry-cmd-");
    tempDirectories.add(directory);
    const progressPath = path.join(directory, "p.json");
    await fs.writeFile(progressPath, JSON.stringify({ status: "running" }), "utf8");

    const result = await fetchProgressFromSource(
      { routineJob: "x", source: { kind: "file", path: progressPath } },
      "T-FOO",
      null
    );
    expect(result?.command).toBe("T-FOO");
  });

  it("returns null when the file cannot be read or parsed", async () => {
    const result = await fetchProgressFromSource(
      { routineJob: "x", source: { kind: "file", path: "/nonexistent/path.json" } },
      "T-X",
      null
    );
    expect(result).toBeNull();
  });

  it("fetches from an HTTP source and returns null on non-OK response", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        command: "repo-fetch",
        status: "running",
        total: 10,
        processed: 3,
        extra: { current_repo: "owner/name" }
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("nope", { status: 503 }));

    const ok = await fetchProgressFromSource(
      {
        routineJob: "github-opc-solution-scan",
        source: { kind: "http", url: "http://api.example/progress/{worker_id}" }
      },
      "T-REPO-FETCH",
      null
    );
    expect(ok).toMatchObject({ command: "repo-fetch", processed: 3, extra: { current_repo: "owner/name" } });
    expect(fetchSpy).toHaveBeenCalledWith("http://api.example/progress/T-REPO-FETCH", expect.any(Object));

    const failed = await fetchProgressFromSource(
      {
        routineJob: "x",
        source: { kind: "http", url: "http://api.example/progress/{worker_id}" }
      },
      "T-X",
      null
    );
    expect(failed).toBeNull();
  });

  it("returns null when the HTTP fetch throws (e.g. timeout)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("aborted"));

    const result = await fetchProgressFromSource(
      { routineJob: "x", source: { kind: "http", url: "http://api.example/progress" } },
      "T-X",
      null
    );
    expect(result).toBeNull();
  });
});
