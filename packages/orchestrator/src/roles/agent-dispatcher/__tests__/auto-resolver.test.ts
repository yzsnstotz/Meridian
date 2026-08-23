import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LifecycleStore } from "../lifecycle-store";
import type { AutoResolveDeps } from "../auto-resolver";
import { autoResolve } from "../auto-resolver";
import type { AutoResolveConfig, HubResult } from "../../../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_UUID = "00000000-0000-0000-0000-000000000000";
const TEST_UUID_2 = "11111111-1111-1111-8111-111111111111";

function makePlan(rows: string[]): string {
  return [
    "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
    "|--------|-------|--------|------|-------|------------|-------|",
    ...rows,
    ""
  ].join("\n");
}

function makeDeps(overrides: Partial<AutoResolveDeps> = {}): AutoResolveDeps {
  return {
    log: {
      info: vi.fn(),
      warn: vi.fn()
    },
    writeWorkerFile: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function makeConfig(overrides: Partial<AutoResolveConfig> = {}): AutoResolveConfig {
  return {
    enabled: true,
    taskspecDir: "/tmp/taskspec",
    maxAutoResolveAttempts: 3,
    humanEscalationPatterns: [/\bMISSING:/i],
    ...overrides
  };
}

function makeHubResult(overrides: Partial<HubResult> = {}): HubResult {
  return {
    trace_id: TEST_UUID,
    thread_id: "t-1",
    source: "claude",
    status: "success",
    run_state: "completed",
    content: "",
    attachments: [],
    timestamp: "2026-01-01T01:00:00.000Z",
    ...overrides
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-resolver-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("autoResolve", () => {
  it("does nothing when disabled", async () => {
    const planPath = path.join(tmpDir, "plan.md");
    await fs.writeFile(planPath, makePlan(["| 🔄 | 0 | PRE-FLIGHT | Check | SONNET | — | |"]));

    const threadsPath = path.join(tmpDir, "dispatch_threads.json");
    const store = new LifecycleStore(threadsPath, { dispatchPlanPath: planPath });

    const config = makeConfig({ enabled: false });
    const deps = makeDeps();
    const report = await autoResolve(store, planPath, config, deps);

    expect(report.generated).toEqual([]);
    expect(report.retried).toEqual([]);
    expect(report.escalated).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  it("generates FIX task for BLOCKED worker", async () => {
    const planPath = path.join(tmpDir, "dispatch_plan.md");
    await fs.writeFile(
      planPath,
      makePlan([
        "| 🔄 | 0 | PRE-FLIGHT | Env Health Check | SONNET | — | |",
        "| ⬜ | 1 | R-01 | Implement feature | OPUS | PRE-FLIGHT | |"
      ])
    );

    const threadsPath = path.join(tmpDir, "dispatch_threads.json");
    const store = new LifecycleStore(threadsPath, { dispatchPlanPath: planPath });

    store.recordWorkerStart("PRE-FLIGHT", "t-1", "trace-1", [], null);
    store.recordWorkerResult("PRE-FLIGHT", makeHubResult({
      content: "⛔ BLOCKED — Cannot find baseline config file"
    }));

    const config = makeConfig();
    const deps = makeDeps();
    const report = await autoResolve(store, planPath, config, deps);

    expect(report.generated).toEqual([
      { fixWorkerId: "FIX-PRE-FLIGHT", blockedWorkerId: "PRE-FLIGHT" }
    ]);

    // Should have written a worker file
    expect(deps.writeWorkerFile).toHaveBeenCalledOnce();
    const callArgs = (deps.writeWorkerFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0]).toContain("FIX-PRE-FLIGHT");
    expect(callArgs[1]).toContain("Resolve Blocker for PRE-FLIGHT");

    // Should have inserted FIX row into plan
    const updatedPlan = await fs.readFile(planPath, "utf8");
    expect(updatedPlan).toContain("FIX-PRE-FLIGHT");

    // The blocked worker's Depends On should now include FIX-PRE-FLIGHT
    expect(updatedPlan).toMatch(/PRE-FLIGHT.*FIX-PRE-FLIGHT|FIX-PRE-FLIGHT.*PRE-FLIGHT/);
  });

  it("skips if FIX row already exists and is pending/running", async () => {
    const planPath = path.join(tmpDir, "dispatch_plan.md");
    await fs.writeFile(
      planPath,
      makePlan([
        "| ⬜ | 0 | FIX-PRE-FLIGHT | Fix blocker | CODEX-HIGH | — | |",
        "| 🔄 | 0 | PRE-FLIGHT | Env Health Check | SONNET | FIX-PRE-FLIGHT | |"
      ])
    );

    const threadsPath = path.join(tmpDir, "dispatch_threads.json");
    const store = new LifecycleStore(threadsPath, { dispatchPlanPath: planPath });

    store.recordWorkerStart("PRE-FLIGHT", "t-1", "trace-1", [], null);
    store.recordWorkerResult("PRE-FLIGHT", makeHubResult({
      content: "⛔ BLOCKED — Cannot find baseline config file"
    }));

    const config = makeConfig();
    const deps = makeDeps();
    const report = await autoResolve(store, planPath, config, deps);

    expect(report.skipped).toContain("PRE-FLIGHT");
    expect(report.generated).toEqual([]);
    expect(deps.writeWorkerFile).not.toHaveBeenCalled();
  });

  it("resets blocked worker when FIX completed", async () => {
    const planPath = path.join(tmpDir, "dispatch_plan.md");
    await fs.writeFile(
      planPath,
      makePlan([
        "| ✅ | 0 | FIX-PRE-FLIGHT | Fix blocker | CODEX-HIGH | — | |",
        "| 🔄 | 0 | PRE-FLIGHT | Env Health Check | SONNET | FIX-PRE-FLIGHT | |"
      ])
    );

    const threadsPath = path.join(tmpDir, "dispatch_threads.json");
    const store = new LifecycleStore(threadsPath, { dispatchPlanPath: planPath });

    // Set up the blocked worker
    store.recordWorkerStart("PRE-FLIGHT", "t-1", "trace-1", [], null);
    store.recordWorkerResult("PRE-FLIGHT", makeHubResult({
      content: "⛔ BLOCKED — Cannot find baseline config file"
    }));

    // Set up the FIX worker as completed
    store.recordWorkerStart("FIX-PRE-FLIGHT", "t-2", "trace-2", [], null);
    store.recordWorkerResult("FIX-PRE-FLIGHT", makeHubResult({
      trace_id: TEST_UUID_2,
      thread_id: "t-2",
      content: "✅ Fix complete — baseline config restored",
      timestamp: "2026-01-01T02:00:00.000Z"
    }));

    const config = makeConfig();
    const deps = makeDeps();
    const report = await autoResolve(store, planPath, config, deps);

    expect(report.retried).toContain("PRE-FLIGHT");

    // Blocked worker should now be pending
    const state = store.load();
    expect(state.workers["PRE-FLIGHT"]?.status).toBe("pending");
    expect(state.workers["PRE-FLIGHT"]?.hub_result).toBeNull();
    expect(state.workers["PRE-FLIGHT"]?.retry_count).toBe(0);
  });

  it("escalates on human escalation patterns", async () => {
    const planPath = path.join(tmpDir, "dispatch_plan.md");
    await fs.writeFile(
      planPath,
      makePlan([
        "| 🔄 | 0 | PRE-FLIGHT | Env Health Check | SONNET | — | |"
      ])
    );

    const threadsPath = path.join(tmpDir, "dispatch_threads.json");
    const store = new LifecycleStore(threadsPath, { dispatchPlanPath: planPath });

    store.recordWorkerStart("PRE-FLIGHT", "t-1", "trace-1", [], null);
    store.recordWorkerResult("PRE-FLIGHT", makeHubResult({
      content: "⛔ BLOCKED — MISSING: AWS credentials for deployment"
    }));

    const config = makeConfig({ humanEscalationPatterns: [/\bMISSING:/i] });
    const deps = makeDeps();
    const report = await autoResolve(store, planPath, config, deps);

    expect(report.escalated).toContain("PRE-FLIGHT");
    expect(report.generated).toEqual([]);
    expect(deps.writeWorkerFile).not.toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it("escalates when FIX worker failed", async () => {
    const planPath = path.join(tmpDir, "dispatch_plan.md");
    await fs.writeFile(
      planPath,
      makePlan([
        "| ❌ | 0 | FIX-PRE-FLIGHT | Fix blocker | CODEX-HIGH | — | |",
        "| 🔄 | 0 | PRE-FLIGHT | Env Health Check | SONNET | FIX-PRE-FLIGHT | |"
      ])
    );

    const threadsPath = path.join(tmpDir, "dispatch_threads.json");
    const store = new LifecycleStore(threadsPath, { dispatchPlanPath: planPath });

    // Set up the blocked worker
    store.recordWorkerStart("PRE-FLIGHT", "t-1", "trace-1", [], null);
    store.recordWorkerResult("PRE-FLIGHT", makeHubResult({
      content: "⛔ BLOCKED — Cannot find baseline config file"
    }));

    // Set up the FIX worker as failed
    store.recordWorkerStart("FIX-PRE-FLIGHT", "t-2", "trace-2", [], null);
    store.recordWorkerResult("FIX-PRE-FLIGHT", makeHubResult({
      trace_id: TEST_UUID_2,
      thread_id: "t-2",
      status: "error",
      content: "Failed to fix the blocker",
      timestamp: "2026-01-01T02:00:00.000Z"
    }));

    const config = makeConfig();
    const deps = makeDeps();
    const report = await autoResolve(store, planPath, config, deps);

    expect(report.escalated).toContain("PRE-FLIGHT");
    expect(deps.log.warn).toHaveBeenCalled();
  });
});
