import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SchedulerRole } from "../../roles/definitions/scheduler";
import { RoleRegistry } from "../../roles/role-registry";
import { RoleRunner } from "../../roles/role-runner";
import type { AppState, SchedulerConfig } from "../../types";
import { computeSchedulerNextRunPreview, createSchedulerHandlers, type SchedulerHandlers } from "../scheduler-handlers";
import { buildEmptyRunState } from "../../roles/scheduler/scheduler-state-store";

const tempDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("computeSchedulerNextRunPreview", () => {
  it("suppresses cron previews after max cycles complete", () => {
    const preview = computeSchedulerNextRunPreview(
      buildConfig(),
      {
        ...buildEmptyRunState(),
        status: "completed_max_cycles",
        completed_cycles: 2,
        last_run_outcome: "completed"
      },
      new Date("2026-04-26T07:00:00.000Z")
    );

    expect(preview).toBeNull();
  });

  it("suppresses cron previews while a run is active", () => {
    const preview = computeSchedulerNextRunPreview(
      buildConfig(),
      {
        ...buildEmptyRunState(),
        status: "active_run",
        current_run_id: "run-active"
      },
      new Date("2026-04-26T07:00:00.000Z")
    );

    expect(preview).toBeNull();
  });

  it("keeps cron previews for schedulers that can accept a future run", () => {
    const preview = computeSchedulerNextRunPreview(
      buildConfig(),
      {
        ...buildEmptyRunState(),
        status: "idle"
      },
      new Date("2026-04-26T07:00:00.000Z")
    );

    expect(preview).toBeTruthy();
  });
});

describe("scheduler config updates", () => {
  it("patches and clears dispatcher provider and model routing settings", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-config-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(dispatchPlanPath, "# Dispatch Plan\n", "utf8");

    const handlers = createHarness();

    await invokeJson(handlers, "POST", "/api/scheduler", {
      thread_id: "scheduler-model-config-test",
      config: buildConfig(dispatchPlanPath)
    });

    await expect(invokeJson(handlers, "PATCH", "/api/scheduler/scheduler-model-config-test/config", {
      agent_type: "claude",
      model_id: "claude-opus-4-6",
      mode: "bridge",
      model_map: {
        OPUS: {
          provider: "claude",
          model_id: "claude-opus-4-6"
        }
      }
    })).resolves.toMatchObject({
      ok: true,
      config: expect.objectContaining({
        agent_type: "claude",
        model_id: "claude-opus-4-6",
        mode: "bridge",
        model_map: {
          OPUS: {
            provider: "claude",
            model_id: "claude-opus-4-6"
          }
        }
      })
    });

    const cleared = await invokeJson<{ config: Record<string, unknown> }>(
      handlers,
      "PATCH",
      "/api/scheduler/scheduler-model-config-test/config",
      {
        model_id: null,
        model_map: null
      }
    );

    expect(cleared.config).not.toHaveProperty("model_id");
    expect(cleared.config).not.toHaveProperty("model_map");
  });

  it("releases completed_max_cycles when max_cycles is increased past completed cycles", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-config-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    const schedulerStatePath = path.join(directory, "scheduler_state.json");
    await fs.writeFile(dispatchPlanPath, "# Dispatch Plan\n", "utf8");
    await fs.writeFile(schedulerStatePath, `${JSON.stringify({
      ...buildEmptyRunState(),
      status: "completed_max_cycles",
      completed_cycles: 2,
      last_run_outcome: "completed",
      last_run_completed_at: "2026-04-26T06:52:50.422Z"
    }, null, 2)}\n`, "utf8");

    const handlers = createHarness();
    const config = buildConfig(dispatchPlanPath);

    await expect(invokeJson(handlers, "POST", "/api/scheduler", {
      thread_id: "scheduler-config-test",
      config: {
        ...config,
        max_cycles: 2
      }
    })).resolves.toMatchObject({
      ok: true,
      scheduler_id: "scheduler-config-test"
    });

    await expect(invokeJson(handlers, "PATCH", "/api/scheduler/scheduler-config-test/config", {
      max_cycles: 5
    })).resolves.toMatchObject({
      ok: true,
      scheduler_id: "scheduler-config-test",
      config: expect.objectContaining({
        max_cycles: 5
      })
    });

    await expect(invokeJson(handlers, "GET", "/api/scheduler/scheduler-config-test")).resolves.toMatchObject({
      ok: true,
      run_state: expect.objectContaining({
        status: "waiting",
        completed_cycles: 2
      })
    });
  });

  it("resumes a manual-intervention scheduler run that still has an active run id", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-resume-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    const schedulerStatePath = path.join(directory, "scheduler_state.json");
    await fs.writeFile(dispatchPlanPath, "# Dispatch Plan\n", "utf8");
    await fs.writeFile(schedulerStatePath, `${JSON.stringify({
      ...buildEmptyRunState(),
      status: "manual_intervention_required",
      current_run_id: "run-needs-recovery",
      last_run_outcome: "manual_intervention_required"
    }, null, 2)}\n`, "utf8");

    const handlers = createHarness();
    await invokeJson(handlers, "POST", "/api/scheduler", {
      thread_id: "scheduler-resume-manual-run",
      config: buildConfig(dispatchPlanPath)
    });

    await expect(invokeJson(handlers, "POST", "/api/scheduler/scheduler-resume-manual-run/resume")).resolves.toMatchObject({
      ok: true,
      scheduler_id: "scheduler-resume-manual-run",
      action: "resumed"
    });

    await expect(invokeJson(handlers, "GET", "/api/scheduler/scheduler-resume-manual-run")).resolves.toMatchObject({
      ok: true,
      run_state: expect.objectContaining({
        status: "active_run",
        current_run_id: "run-needs-recovery"
      })
    });
  });

  it("resumes the scheduler engine directly when runner status update is a no-op", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-direct-resume-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    const schedulerStatePath = path.join(directory, "scheduler_state.json");
    await fs.writeFile(dispatchPlanPath, "# Dispatch Plan\n", "utf8");
    await fs.writeFile(schedulerStatePath, `${JSON.stringify({
      ...buildEmptyRunState(),
      status: "manual_intervention_required",
      current_run_id: "run-direct-resume",
      last_run_outcome: "manual_intervention_required"
    }, null, 2)}\n`, "utf8");

    const stateStore = new MemoryStateStore();
    const role = new SchedulerRole("scheduler-direct-resume", buildConfig(dispatchPlanPath), {
      stateStore,
      launchDispatcher: async () => ({
        ok: true,
        threadId: "dispatcher-thread-test"
      }),
      meridianApi: {
        spawn: async () => ({ threadId: "spawn-thread-test" }),
        run: async (request) => ({
          threadId: request.threadId,
          status: "success",
          raw: {}
        }),
        kill: async (threadId) => ({
          threadId,
          status: "killed",
          raw: {}
        }),
        listCredentials: async () => []
      }
    });
    await role.onActivate({
      sendToHub: async () => undefined,
      listInstances: () => [],
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      }
    });

    const runner = {
      getRole: (threadId: string) => threadId === role.threadId ? role : null,
      resumeRole: vi.fn(async () => false)
    } as unknown as RoleRunner;
    const handlers = createSchedulerHandlers({
      runner,
      registry: new RoleRegistry(),
      stateStore,
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      }
    });

    await expect(invokeJson(handlers, "POST", "/api/scheduler/scheduler-direct-resume/resume")).resolves.toMatchObject({
      ok: true,
      scheduler_id: "scheduler-direct-resume",
      action: "resumed"
    });

    expect(JSON.parse(await fs.readFile(schedulerStatePath, "utf8"))).toMatchObject({
      status: "active_run",
      current_run_id: "run-direct-resume"
    });
    expect(runner.resumeRole).toHaveBeenCalledWith("scheduler-direct-resume");
  });

  it("returns dispatcher-style plan rows and worker reply details", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-detail-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    const sidecarPath = path.join(directory, "dispatch_threads.json");
    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ✅ | 1 | R-01 | Build scheduler GUI controls | CODEX | — | PRD | done |",
      "| ⬜ | 1 | R-02 | Add browser tests | CODEX | R-01 | PRD | ready |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-scheduler",
        started_at: "2026-04-27T01:00:00.000Z",
        status: "running"
      },
      workers: {
        "R-01": {
          thread_id: "worker-thread-r01",
          trace_id: "11111111-1111-4111-8111-111111111111",
          started_at: "2026-04-27T01:01:00.000Z",
          last_seen_at: "2026-04-27T01:03:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: {
            trace_id: "11111111-1111-4111-8111-111111111111",
            thread_id: "worker-thread-r01",
            source: "codex",
            status: "success",
            run_state: "completed",
            content: "Agent completed R-01.",
            details_text: [
              "Your message:",
              "Run R-01.",
              "",
              "Agent reply:",
              "Agent completed R-01."
            ].join("\n"),
            attachments: [],
            timestamp: "2026-04-27T01:03:00.000Z"
          },
          command_preamble: "Run R-01.",
          retry_count: 0
        }
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    const handlers = createHarness();
    await invokeJson(handlers, "POST", "/api/scheduler", {
      thread_id: "scheduler-detail-data",
      config: buildConfig(dispatchPlanPath)
    });

    const detail = await invokeJson<{
      dispatch_plan?: { rows?: Array<Record<string, unknown>> };
      dispatch_details?: Array<Record<string, unknown>>;
      continue_worker?: string | null;
      current_worker?: string | null;
    }>(handlers, "GET", "/api/scheduler/scheduler-detail-data");

    expect(detail.dispatch_plan?.rows).toEqual([
      expect.objectContaining({
        worker: "R-01",
        lifecycle_status: "completed",
        thread_id: "worker-thread-r01"
      }),
      expect.objectContaining({
        worker: "R-02",
        lifecycle_status: null
      })
    ]);
    expect(detail.dispatch_details).toEqual([
      expect.objectContaining({
        worker_id: "R-01",
        status: "completed",
        command: expect.objectContaining({ content: "Run R-01." }),
        reply: expect.objectContaining({ content: "Agent completed R-01." })
      })
    ]);
    expect(detail.continue_worker).toBe("R-02");
    expect(detail.current_worker).toBeNull();
  });

  it("promotes abandoned plan rows when pidless tool progress is still running", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-progress-"));
    tempDirectories.add(directory);

    const manifestPath = path.join(directory, "changed_skill_manifest.json");
    const progressPath = path.join(directory, "ssr-enrich.progress.json");
    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    const sidecarPath = path.join(directory, "dispatch_threads.json");
    await fs.writeFile(manifestPath, `${JSON.stringify({
      scan_run_id: "daily-2026-04-28",
      skills: [
        {
          owner: "nengnengz",
          slug: "baoyu-slide-deck-2",
          latest_version: "0.1.0",
          updated_at: "2026-04-28T07:01:56.533Z",
          change_type: "updated"
        }
      ]
    }, null, 2)}\n`, "utf8");
    await fs.writeFile(progressPath, `${JSON.stringify({
      schema_version: 1,
      command: "ssr-enrich",
      scan_run_id: "daily-2026-04-28",
      status: "running",
      manifest_path: manifestPath,
      output_path: path.join(directory, "enrichment.json"),
      total: 13536,
      processed: 1813,
      success: 1813,
      failed: 0,
      skipped: 0,
      remaining: 11723,
      started_at: "2026-04-28T14:04:45.900Z",
      updated_at: "2026-04-28T14:41:38.000Z",
      last_skill: {
        owner: "nengnengz",
        slug: "baoyu-slide-deck-2"
      }
    }, null, 2)}\n`, "utf8");
    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      `| ⚠️ ABANDONED | 3 | W-SSR | Run \`clawhub-fetch ssr-enrich --scan-run-id daily-2026-04-28 --db ${path.join(directory, "clawhub.db")} --manifest ${manifestPath} --enrichment-path ${path.join(directory, "enrichment.json")}\` | CODEX | W-DETAIL | PRD | stale lifecycle row |`
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-scheduler",
        started_at: "2026-04-28T14:00:00.000Z",
        status: "running"
      },
      workers: {
        "W-SSR": {
          thread_id: "worker-thread-ssr",
          trace_id: "22222222-2222-4222-8222-222222222222",
          started_at: "2026-04-28T14:04:09.956Z",
          last_seen_at: "2026-04-28T14:35:06.175Z",
          status: "abandoned",
          expected_outputs: [],
          hub_result: null,
          retry_count: 0
        }
      },
      last_reconciled_at: "2026-04-28T14:45:07.322Z"
    }, null, 2)}\n`, "utf8");

    const handlers = createHarness();
    await invokeJson(handlers, "POST", "/api/scheduler", {
      thread_id: "scheduler-progress-test",
      config: buildConfig(dispatchPlanPath)
    });

    const detail = await invokeJson<{
      dispatch_plan?: { rows?: Array<Record<string, unknown>> };
    }>(handlers, "GET", "/api/scheduler/scheduler-progress-test");

    expect(detail.dispatch_plan?.rows?.[0]).toMatchObject({
      worker: "W-SSR",
      status: "🔄",
      lifecycle_status: "running",
      progress: expect.objectContaining({
        command: "ssr-enrich",
        status: "running",
        processed: 1813,
        remaining: 11723,
        last_skill: {
          owner: "nengnengz",
          slug: "baoyu-slide-deck-2"
        }
      })
    });
  });

  it("continues a scheduler worker through the scheduler-scoped endpoint", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-continue-"));
    tempDirectories.add(directory);
    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ⬜ | 1 | R-01 | Continue from scheduler | CODEX | — | PRD | ready |"
    ].join("\n"), "utf8");

    const continueWorker = vi.fn(async () => ({
      ok: true,
      workerId: "R-01",
      threadId: "worker-thread-r01"
    }));
    const handlers = createHarness({ continueWorker });
    await invokeJson(handlers, "POST", "/api/scheduler", {
      thread_id: "scheduler-worker-continue",
      config: buildConfig(dispatchPlanPath)
    });

    await expect(invokeJson(
      handlers,
      "POST",
      "/api/scheduler/scheduler-worker-continue/worker/R-01/continue",
      {}
    )).resolves.toMatchObject({
      ok: true,
      status: "continued",
      message: "continued: R-01",
      worker: "R-01"
    });
    expect(continueWorker).toHaveBeenCalledWith(
      expect.objectContaining({ dispatch_plan_path: dispatchPlanPath }),
      "R-01"
    );
  });

  it("updates scheduler worker resume and manual statuses through scheduler endpoints", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-actions-"));
    tempDirectories.add(directory);
    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    const sidecarPath = path.join(directory, "dispatch_threads.json");
    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| 🔄 | 1 | R-01 | Running worker | CODEX | — | PRD | active |"
    ].join("\n"), "utf8");
    await fs.writeFile(sidecarPath, `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "dispatcher-thread-scheduler",
        started_at: "2026-04-27T01:00:00.000Z",
        status: "running"
      },
      workers: {
        "R-01": {
          thread_id: "worker-thread-r01",
          trace_id: "22222222-2222-4222-8222-222222222222",
          started_at: "2026-04-27T01:01:00.000Z",
          last_seen_at: "2026-04-27T01:02:00.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: "Run R-01.",
          retry_count: 0
        }
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    const handlers = createHarness();
    await invokeJson(handlers, "POST", "/api/scheduler", {
      thread_id: "scheduler-worker-actions",
      config: buildConfig(dispatchPlanPath)
    });

    await expect(invokeJson(
      handlers,
      "POST",
      "/api/scheduler/scheduler-worker-actions/worker/R-01/resume",
      { action: "skip" }
    )).resolves.toMatchObject({
      ok: true,
      result: expect.objectContaining({
        worker: "R-01",
        action: "skip",
        status: "skipped"
      })
    });
    await expect(fs.readFile(dispatchPlanPath, "utf8")).resolves.toContain("| ⛔ SKIPPED | 1 | R-01 |");

    await expect(invokeJson(
      handlers,
      "PATCH",
      "/api/scheduler/scheduler-worker-actions/worker/R-01/status",
      { status: "completed" }
    )).resolves.toMatchObject({
      ok: true,
      result: expect.objectContaining({
        worker: "R-01",
        status: "completed"
      })
    });
    await expect(fs.readFile(dispatchPlanPath, "utf8")).resolves.toContain("| ✅ | 1 | R-01 |");
  });

  it("resolves a completed human gate into the archived scheduler result", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-scheduler-gate-"));
    tempDirectories.add(directory);
    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    const schedulerStatePath = path.join(directory, "scheduler_state.json");
    const runDir = path.join(directory, "reports", "runs", "run-gate-1");
    const reportPath = path.join(runDir, "report.md");
    const reportJsonPath = path.join(runDir, "report.json");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |",
      "|--------|-------|--------|------|-------|------------|----------------|-------|",
      "| ⬜ | 1 | P0-INTEGRATION-GATE | Human gate | HUMAN | P0-COVERAGE-PROBE | TaskSpec | pending |"
    ].join("\n"), "utf8");
    const runSummary = {
      run_id: "run-gate-1",
      scheduler_mode: "cron",
      planned_start_time: null,
      actual_start_time: "2026-04-27T22:00:00.000Z",
      completed_time: "2026-04-28T01:00:00.000Z",
      duration_seconds: 10800,
      dispatcher_thread_id: "codex_84",
      terminal_outcome: "manual_intervention_required",
      workers: [
        {
          worker_id: "P0-INTEGRATION-GATE",
          status: "⬜",
          retry_count: 0,
          report_path: path.join(runDir, "worker_outputs", "P0-INTEGRATION-GATE.md")
        }
      ]
    };
    await fs.writeFile(reportJsonPath, `${JSON.stringify(runSummary, null, 2)}\n`, "utf8");
    await fs.writeFile(
      reportPath,
      "# Scheduler Run Report\n\n| Terminal Outcome | manual_intervention_required |\n| P0-INTEGRATION-GATE | ⬜ |\n",
      "utf8"
    );
    await fs.writeFile(schedulerStatePath, `${JSON.stringify({
      ...buildEmptyRunState(),
      status: "manual_intervention_required",
      completed_cycles: 1,
      last_run_outcome: "manual_intervention_required",
      last_run_completed_at: "2026-04-28T01:00:00.000Z",
      last_report_path: reportPath,
      run_history: [runSummary]
    }, null, 2)}\n`, "utf8");

    const handlers = createHarness();
    await invokeJson(handlers, "POST", "/api/scheduler", {
      thread_id: "scheduler-gate-actions",
      config: {
        ...buildConfig(dispatchPlanPath),
        report_base_dir: path.join(directory, "reports"),
        max_cycles: 1
      }
    });

    await expect(invokeJson(
      handlers,
      "POST",
      "/api/scheduler/scheduler-gate-actions/manual-gate/complete",
      {
        worker_id: "P0-INTEGRATION-GATE",
        status: "completed",
        note: "operator reviewed all P0 evidence",
        checklist: [
          {
            id: "scheduler-owned-run",
            label: "Scheduler-owned run",
            status: "passed",
            note: "run report matches dashboard",
            evidence: "/tmp/run/report.md"
          }
        ]
      }
    )).resolves.toMatchObject({
      ok: true,
      scheduler_id: "scheduler-gate-actions",
      status: "completed_max_cycles",
      last_run_outcome: "completed",
      worker: "P0-INTEGRATION-GATE"
    });

    const state = JSON.parse(await fs.readFile(schedulerStatePath, "utf8"));
    expect(state.status).toBe("completed_max_cycles");
    expect(state.last_run_outcome).toBe("completed");
    expect(state.run_history[0].terminal_outcome).toBe("completed");
    expect(state.run_history[0].workers[0].status).toBe("completed");
    const reportJson = JSON.parse(await fs.readFile(reportJsonPath, "utf8"));
    expect(reportJson.terminal_outcome).toBe("completed");
    await expect(fs.readFile(reportPath, "utf8")).resolves.toContain("| Terminal Outcome | completed |");
    const workerReport = await fs.readFile(
      path.join(runDir, "worker_outputs", "P0-INTEGRATION-GATE.md"),
      "utf8"
    );
    expect(workerReport).toContain("scheduler-owned-run");
    expect(workerReport).toContain("run report matches dashboard");
  });
});

function buildConfig(dispatchPlanPath = path.join("/tmp", "dispatch_plan.md")): SchedulerConfig {
  return {
    dispatch_plan_path: dispatchPlanPath,
    command_file_path: path.join(path.dirname(dispatchPlanPath), "agent_dispatch_command.md"),
    dispatch_repo_root: path.dirname(dispatchPlanPath),
    docs_root: path.dirname(dispatchPlanPath),
    user_reply_channels: [{ channel: "web", chat_id: "web:ops" }],
    agent_type: "codex",
    mode: "pane_bridge",
    kill_policy: "always",
    auto_approve: true,
    scheduler_mode: "cron",
    cron_expression: "0 6 * * *",
    timezone: "Asia/Tokyo",
    delay_between_cycles_seconds: 0,
    report_base_dir: path.join("/tmp", "reports"),
    catch_up_policy: "skip_missed"
  };
}

class MemoryStateStore {
  private currentState: AppState | null = null;

  async load(): Promise<AppState | null> {
    return this.currentState ? structuredClone(this.currentState) : null;
  }

  async save(state: AppState): Promise<void> {
    this.currentState = structuredClone(state);
  }
}

function createHarness(options: {
  continueWorker?: (config: SchedulerConfig, workerId: string) => Promise<{ ok: boolean; workerId: string; threadId?: string; error?: string }>;
} = {}): SchedulerHandlers {
  const stateStore = new MemoryStateStore();
  const registry = new RoleRegistry();
  const runner = new RoleRunner({
    sendToHub: async () => undefined,
    listInstances: () => [],
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    }
  });

  registry.register("scheduler", (threadId, config) => new SchedulerRole(threadId, config, {
    stateStore,
    launchDispatcher: async () => ({
      ok: true,
      threadId: "dispatcher-thread-test"
    }),
    continueWorker: options.continueWorker,
    meridianApi: {
      spawn: async () => ({ threadId: "spawn-thread-test" }),
      run: async (request) => ({
        threadId: request.threadId,
        status: "success",
        raw: {}
      }),
      kill: async (threadId) => ({
        threadId,
        status: "killed",
        raw: {}
      }),
      listCredentials: async () => []
    }
  }));

  return createSchedulerHandlers({
    runner,
    registry,
    stateStore,
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    }
  });
}

async function invokeJson<T = unknown>(
  handlers: SchedulerHandlers,
  method: string,
  url: string,
  body?: unknown
): Promise<T> {
  const request = createJsonRequest(method, url, body);
  const response = createJsonResponse();
  const handled = await handlers.handle(request, response.raw);

  expect(handled).toBe(true);
  return JSON.parse(response.body) as T;
}

function createJsonRequest(method: string, url: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const request = Readable.from(payload ? [payload] : []) as IncomingMessage;
  request.method = method;
  request.url = url;
  request.headers = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload).toString()
  };
  return request;
}

function createJsonResponse(): { raw: ServerResponse; body: string; statusCode: number } {
  const chunks: string[] = [];
  const response = {
    statusCode: 200,
    setHeader: vi.fn(),
    writeHead(statusCode: number): ServerResponse {
      response.statusCode = statusCode;
      return response as unknown as ServerResponse;
    },
    end(chunk?: unknown): ServerResponse {
      if (typeof chunk === "string") chunks.push(chunk);
      else if (Buffer.isBuffer(chunk)) chunks.push(chunk.toString("utf8"));
      return response as unknown as ServerResponse;
    }
  };

  return {
    raw: response as unknown as ServerResponse,
    get body() {
      return chunks.join("");
    },
    get statusCode() {
      return response.statusCode;
    }
  };
}
