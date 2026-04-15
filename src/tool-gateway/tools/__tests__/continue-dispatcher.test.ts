import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LifecycleStore } from "../../../roles/agent-dispatcher/lifecycle-store";
import { executeContinueDispatcher, type ContinueDispatcherDeps } from "../continue-dispatcher";
import type { AppState, DispatchThreadStateV2 } from "../../../types";

const tempDirectories = new Set<string>();

describe("continue-dispatcher tool", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
    tempDirectories.clear();
  });

  it("continues the next eligible worker locally when the roles service is unreachable", async () => {
    const harness = await createHarness({
      dispatcherStatus: "paused",
      planMarkdown: [
        "# Dispatch Plan",
        "",
        "| Status | Batch | Worker | Task | Model | Depends On |",
        "|--------|-------|--------|------|-------|------------|",
        "| ✅ | 1 | N-01 | Prior step | CODEX | — |",
        "| ⬜ | 2 | N-02 | Current step | CODEX | N-01 |",
        ""
      ].join("\n"),
      lifecycleState: {
        version: 2,
        dispatcher: {
          thread_id: "dispatcher-thread-123",
          started_at: "2026-04-10T00:00:00.000Z",
          status: "running"
        },
        workers: {},
        last_reconciled_at: null
      }
    });
    const continueWorker = vi.fn().mockResolvedValue({
      ok: true,
      workerId: "N-02",
      threadId: "worker-thread-456"
    });

    const result = await executeContinueDispatcher(
      { dispatcherId: harness.dispatcherId },
      harness.createDeps({ continueWorker })
    );

    expect(result).toEqual({
      ok: true,
      status: "continued",
      message: "continued: N-02",
      dispatcher_thread_id: "dispatcher-thread-123",
      worker: "N-02"
    });
    expect(continueWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatch_plan_path: harness.planPath,
        command_file_path: harness.commandFilePath
      }),
      [
        {
          status: "✅",
          batch: "1",
          worker: "N-01",
          model: "CODEX",
          depends_on: []
        },
        {
          status: "⬜",
          batch: "2",
          worker: "N-02",
          model: "CODEX",
          depends_on: ["N-01"]
        }
      ],
      "N-02"
    );
    expect(harness.state.roles[0]?.status).toBe("active");
  });

  it("reports still_blocked locally when another non-human worker is already running", async () => {
    const harness = await createHarness({
      planMarkdown: [
        "# Dispatch Plan",
        "",
        "| Status | Batch | Worker | Task | Model | Depends On |",
        "|--------|-------|--------|------|-------|------------|",
        "| 🔄 | 5 | R-07 | Integration Repair | CODEX | — |",
        "| ⚠️ ABANDONED | 5 | R-08 | Delta Check | CODEX | R-07 |",
        ""
      ].join("\n"),
      lifecycleState: {
        version: 2,
        dispatcher: {
          thread_id: "dispatcher-thread-123",
          started_at: "2026-04-10T00:00:00.000Z",
          status: "running"
        },
        workers: {
          "R-07": {
            thread_id: "worker-thread-running",
            trace_id: null,
            started_at: "2026-04-10T00:00:00.000Z",
            last_seen_at: "2026-04-10T00:05:00.000Z",
            status: "running",
            expected_outputs: [],
            hub_result: null,
            command_preamble: null,
            retry_count: 0
          }
        },
        last_reconciled_at: null
      }
    });
    const continueWorker = vi.fn();

    const result = await executeContinueDispatcher(
      {
        dispatcherId: harness.dispatcherId,
        workerId: "R-08"
      },
      harness.createDeps({ continueWorker })
    );

    expect(result).toEqual({
      ok: true,
      status: "still_blocked",
      message: "still blocked: running worker(s): R-07",
      worker: "R-08",
      running_workers: ["R-07"]
    });
    expect(continueWorker).not.toHaveBeenCalled();
  });

  it("preserves local_tool_bootstrap_failed semantics in the local fallback path", async () => {
    const harness = await createHarness({
      planMarkdown: [
        "# Dispatch Plan",
        "",
        "| Status | Batch | Worker | Task | Model | Depends On |",
        "|--------|-------|--------|------|-------|------------|",
        "| ⚠️ ABANDONED | 5 | R-08 | Delta Check | CODEX | — |",
        ""
      ].join("\n"),
      lifecycleState: {
        version: 2,
        dispatcher: {
          thread_id: "dispatcher-thread-123",
          started_at: "2026-04-10T00:00:00.000Z",
          status: "running"
        },
        workers: {},
        last_reconciled_at: null
      }
    });
    const continueWorker = vi.fn().mockResolvedValue({
      ok: false,
      workerId: "R-08",
      error: "run launch failed: ENOENT",
      localToolBootstrapFailure: true
    });

    const result = await executeContinueDispatcher(
      { dispatcherId: harness.dispatcherId },
      harness.createDeps({ continueWorker })
    );

    expect(result).toEqual({
      ok: true,
      status: "local_tool_bootstrap_failed",
      message: "local tool bootstrap failed: run launch failed: ENOENT",
      worker: "R-08",
      error: "run launch failed: ENOENT"
    });
  });

  it("repairs legacy detached docs roots before local continuation launches a worker", async () => {
    const harness = await createDetachedDocsHarness({
      planMarkdown: [
        "# Dispatch Plan",
        "",
        "| Status | Batch | Worker | Task | Model | Depends On |",
        "|--------|-------|--------|------|-------|------------|",
        "| ✅ | 1 | PRE-FLIGHT | Prior step | OPUS | — |",
        "| ❌ | 2 | R-01 | Current step | CODEX | PRE-FLIGHT |",
        ""
      ].join("\n"),
      lifecycleState: {
        version: 2,
        dispatcher: {
          thread_id: "dispatcher-thread-123",
          started_at: "2026-04-10T00:00:00.000Z",
          status: "running"
        },
        workers: {},
        last_reconciled_at: null
      }
    });
    const continueWorker = vi.fn().mockResolvedValue({
      ok: true,
      workerId: "R-01",
      threadId: "worker-thread-456"
    });

    await executeContinueDispatcher(
      { dispatcherId: harness.dispatcherId },
      harness.createDeps({ continueWorker })
    );

    expect(continueWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatch_plan_path: harness.planPath,
        command_file_path: harness.commandFilePath,
        dispatch_repo_root: harness.repoRoot
      }),
      expect.any(Array),
      "R-01"
    );
  });
});

async function createHarness(options: {
  dispatcherStatus?: string;
  planMarkdown: string;
  lifecycleState: DispatchThreadStateV2;
}): Promise<{
  dispatcherId: string;
  planPath: string;
  commandFilePath: string;
  state: AppState;
  createDeps(overrides?: {
    continueWorker?: ContinueDispatcherDeps["continueWorker"];
  }): ContinueDispatcherDeps;
}> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-continue-dispatcher-"));
  tempDirectories.add(directory);

  const dispatcherId = "agent-dispatcher-r03";
  const planPath = path.join(directory, "dispatch_plan.md");
  const commandFilePath = path.join(directory, "agent_dispatch_command.md");
  const sidecarPath = path.join(directory, "dispatch_threads.json");

  await fs.writeFile(planPath, options.planMarkdown, "utf8");
  await fs.writeFile(commandFilePath, "# command\n", "utf8");
  new LifecycleStore(sidecarPath, { dispatchPlanPath: planPath }).save(options.lifecycleState);

  const state: AppState = {
    roles: [
      {
        threadId: dispatcherId,
        roleType: "agent-dispatcher",
        status: options.dispatcherStatus ?? "active",
        config: {
          dispatch_plan_path: planPath,
          command_file_path: commandFilePath,
          user_reply_channels: [
            {
              channel: "web",
              chat_id: "web:ops"
            }
          ],
          agent_type: "codex",
          mode: "bridge",
          kill_policy: "always"
        }
      }
    ],
    promptStore: {}
  };

  return {
    dispatcherId,
    planPath,
    commandFilePath,
    state,
    createDeps(overrides = {}) {
      return {
        loadState: async () => state,
        readFile: (filePath: string) => fs.readFile(filePath, "utf8"),
        saveState: async (nextState: AppState) => {
          state.roles = nextState.roles;
          state.promptStore = nextState.promptStore;
        },
        loadLifecycle: () => new LifecycleStore(sidecarPath, { dispatchPlanPath: planPath }).load(),
        continueWorker: overrides.continueWorker ?? vi.fn().mockResolvedValue({
          ok: true,
          workerId: "unused"
        }),
        postContinue: async () => ({
          ok: false,
          error: "Meridian-roles service unreachable at http://127.0.0.1:7701/: fetch failed",
          base_url: "http://127.0.0.1:7701/",
          service_unreachable: true
        })
      };
    }
  };
}

async function createDetachedDocsHarness(options: {
  planMarkdown: string;
  lifecycleState: DispatchThreadStateV2;
}): Promise<{
  dispatcherId: string;
  planPath: string;
  commandFilePath: string;
  repoRoot: string;
  createDeps(overrides?: {
    continueWorker?: ContinueDispatcherDeps["continueWorker"];
  }): ContinueDispatcherDeps;
}> {
  const workspaceRoot = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-continue-detached-"));
  tempDirectories.add(workspaceRoot);
  const repoRootPath = path.join(workspaceRoot, "projects/clawso");
  await fs.mkdir(path.join(repoRootPath, ".git"), { recursive: true });

  const dispatcherId = "agent-dispatcher-r03";
  const planPath = path.join(
    workspaceRoot,
    "Docs/Projects/clawso/branch/feat-cli/taskspec/dispatch_plan.md"
  );
  const commandFilePath = path.join(
    workspaceRoot,
    "Docs/Projects/clawso/branch/feat-cli/taskspec/agent_dispatch_command.md"
  );
  const sidecarPath = path.join(path.dirname(planPath), "dispatch_threads.json");

  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, options.planMarkdown, "utf8");
  await fs.writeFile(commandFilePath, "# command\n", "utf8");
  new LifecycleStore(sidecarPath, { dispatchPlanPath: planPath }).save(options.lifecycleState);

  const state: AppState = {
    roles: [
      {
        threadId: dispatcherId,
        roleType: "agent-dispatcher",
        status: "active",
        config: {
          dispatch_plan_path: planPath,
          command_file_path: commandFilePath,
          dispatch_repo_root: workspaceRoot,
          docs_root: path.join(workspaceRoot, "Docs"),
          user_reply_channels: [
            {
              channel: "web",
              chat_id: "web:ops"
            }
          ],
          agent_type: "codex",
          mode: "bridge",
          kill_policy: "always"
        }
      }
    ],
    promptStore: {}
  };

  return {
    dispatcherId,
    planPath,
    commandFilePath,
    repoRoot: await fs.realpath(repoRootPath),
    createDeps(overrides = {}) {
      return {
        loadState: async () => state,
        readFile: (filePath: string) => fs.readFile(filePath, "utf8"),
        saveState: async (nextState: AppState) => {
          state.roles = nextState.roles;
          state.promptStore = nextState.promptStore;
        },
        loadLifecycle: () => new LifecycleStore(sidecarPath, { dispatchPlanPath: planPath }).load(),
        continueWorker: overrides.continueWorker ?? vi.fn().mockResolvedValue({
          ok: true,
          workerId: "unused"
        }),
        postContinue: async () => ({
          ok: false,
          error: "Meridian-roles service unreachable at http://127.0.0.1:7701/: fetch failed",
          base_url: "http://127.0.0.1:7701/",
          service_unreachable: true
        })
      };
    }
  };
}
