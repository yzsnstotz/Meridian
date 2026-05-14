import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StateStore } from "./state-store";
import { hasStartupRecoverableDispatchWork, resolveDispatchPlanPathsFromState } from "./index";
import { buildEmptyRunState } from "./roles/scheduler/scheduler-state-store";
import { AgentDispatcherConfigSchema, type SchedulerConfig } from "./types";

const tempDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("resolveDispatchPlanPathsFromState", () => {
  it("includes terminal agent-dispatcher plans so watchdog can reconcile late worker outcomes", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-index-"));
    tempDirectories.add(directory);

    const failedPlanPath = path.join(directory, "failed", "dispatch_plan.md");
    const completedPlanPath = path.join(directory, "completed", "dispatch_plan.md");
    const stateStore = new StateStore(path.join(directory, "state.json"));

    await fs.mkdir(path.dirname(failedPlanPath), { recursive: true });
    await fs.mkdir(path.dirname(completedPlanPath), { recursive: true });
    await fs.writeFile(failedPlanPath, "# Failed Dispatch Plan\n", "utf8");
    await fs.writeFile(completedPlanPath, "# Completed Dispatch Plan\n", "utf8");
    await stateStore.save({
      roles: [
        {
          threadId: "dispatcher-failed",
          roleType: "agent-dispatcher",
          status: "failed",
          config: buildAgentDispatcherConfig(failedPlanPath)
        },
        {
          threadId: "dispatcher-completed",
          roleType: "agent-dispatcher",
          status: "completed",
          config: buildAgentDispatcherConfig(completedPlanPath)
        }
      ],
      promptStore: {}
    });

    await expect(resolveDispatchPlanPathsFromState(stateStore)).resolves.toEqual([
      failedPlanPath,
      completedPlanPath
    ]);
  });

  it("marks active terminal agent-dispatchers completed and excludes them from watchdog relaunch", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-index-terminal-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    const stateStore = new StateStore(path.join(directory, "state.json"));

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| ✅ | 1 | N-01 | Done | CODEX | - | delivered |",
      "| ⬜ | 2 | V-01-B | Human review | HUMAN | N-01 | awaiting human sign-off |"
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(directory, "dispatch_threads.json"), `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "codex_01",
        started_at: "2026-05-05T21:42:51.459Z",
        status: "abandoned"
      },
      workers: {
        "N-01": {
          thread_id: "codex_55",
          trace_id: null,
          started_at: "2026-05-05T06:39:43.287Z",
          last_seen_at: "2026-05-05T06:44:28.924Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "DISPATCHER": {
          thread_id: "codex_01",
          trace_id: null,
          started_at: "2026-05-05T21:42:51.470Z",
          last_seen_at: "2026-05-05T21:43:17.761Z",
          status: "abandoned",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 2
        }
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");
    await stateStore.save({
      roles: [
        {
          threadId: "agent-dispatcher-terminal",
          roleType: "agent-dispatcher",
          status: "active",
          config: buildAgentDispatcherConfig(dispatchPlanPath)
        }
      ],
      promptStore: {}
    });

    await expect(resolveDispatchPlanPathsFromState(stateStore)).resolves.toEqual([]);
    await expect(stateStore.load()).resolves.toMatchObject({
      roles: [
        {
          threadId: "agent-dispatcher-terminal",
          status: "completed"
        }
      ]
    });
  });

  it("keeps terminal agent-dispatchers in watchdog scope when lifecycle rows still disagree with the plan", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-index-terminal-late-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    const stateStore = new StateStore(path.join(directory, "state.json"));

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| ✅ | 1 | N-01 | Done | CODEX | - | delivered |"
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(directory, "dispatch_threads.json"), `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: null,
        started_at: null,
        status: "completed"
      },
      workers: {},
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");
    await stateStore.save({
      roles: [
        {
          threadId: "agent-dispatcher-completed-late",
          roleType: "agent-dispatcher",
          status: "completed",
          config: buildAgentDispatcherConfig(dispatchPlanPath)
        }
      ],
      promptStore: {}
    });

    await expect(resolveDispatchPlanPathsFromState(stateStore)).resolves.toEqual([dispatchPlanPath]);
  });

  it("kills lingering codex threads when settling a freshly terminal dispatcher role", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-index-settle-kill-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    const stateStore = new StateStore(path.join(directory, "state.json"));

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| ✅ | 1 | N-01 | Done | CODEX | - | delivered |"
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(directory, "dispatch_threads.json"), `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "codex_01",
        started_at: "2026-05-05T21:42:51.459Z",
        status: "running"
      },
      workers: {
        "N-01": {
          thread_id: "codex_55",
          trace_id: null,
          started_at: "2026-05-05T06:39:43.287Z",
          last_seen_at: "2026-05-05T06:44:28.924Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          validation: {
            current_cycle: 1,
            max_fix_cycles: 3,
            validator_thread_id: "codex_77",
            last_score: null,
            last_feedback: null,
            history: []
          }
        }
      },
      pm_resolvers: [
        {
          thread_id: "codex_99",
          status: "completed",
          started_at: "2026-05-05T07:00:00.000Z",
          last_seen_at: "2026-05-05T07:05:00.000Z",
          agent_type: "codex",
          model_id: "gpt-5",
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention",
            worker_id: "N-01",
            message: null,
            error: null,
            source: "dispatcher"
          },
          result: null,
          error: null,
          transport_error: null
        }
      ],
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");
    await stateStore.save({
      roles: [
        {
          threadId: "agent-dispatcher-settling",
          roleType: "agent-dispatcher",
          status: "active",
          config: buildAgentDispatcherConfig(dispatchPlanPath)
        }
      ],
      promptStore: {}
    });

    const killed: string[] = [];
    const killThread = async (threadId: string): Promise<void> => {
      killed.push(threadId);
    };

    await expect(
      resolveDispatchPlanPathsFromState(stateStore, { killThread })
    ).resolves.toEqual([]);

    expect(killed.sort()).toEqual(["codex_01", "codex_55", "codex_77", "codex_99"]);
  });

  it("honors kill_policy=never on settle by leaving worker threads alive (only dispatcher is killed)", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-index-settle-never-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    const stateStore = new StateStore(path.join(directory, "state.json"));

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| ✅ | 1 | N-01 | Done | CODEX | - | delivered |"
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(directory, "dispatch_threads.json"), `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "codex_01",
        started_at: "2026-05-05T21:42:51.459Z",
        status: "running"
      },
      workers: {
        "N-01": {
          thread_id: "codex_55",
          trace_id: null,
          started_at: "2026-05-05T06:39:43.287Z",
          last_seen_at: "2026-05-05T06:44:28.924Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");
    await stateStore.save({
      roles: [
        {
          threadId: "agent-dispatcher-never",
          roleType: "agent-dispatcher",
          status: "active",
          config: AgentDispatcherConfigSchema.parse({
            ...buildAgentDispatcherConfig(dispatchPlanPath),
            kill_policy: "never"
          })
        }
      ],
      promptStore: {}
    });

    const killed: string[] = [];
    const killThread = async (threadId: string): Promise<void> => {
      killed.push(threadId);
    };

    await expect(
      resolveDispatchPlanPathsFromState(stateStore, { killThread })
    ).resolves.toEqual([]);

    expect(killed).toEqual(["codex_01"]);
  });

  it("does not invoke killThread on settle ticks that flip nothing (idempotent across watchdog ticks)", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-index-settle-idempotent-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    const stateStore = new StateStore(path.join(directory, "state.json"));

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| ✅ | 1 | N-01 | Done | CODEX | - | delivered |"
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(directory, "dispatch_threads.json"), `${JSON.stringify({
      version: 2,
      dispatcher: { thread_id: "codex_01", started_at: "2026-05-05T21:42:51.459Z", status: "running" },
      workers: {
        "N-01": {
          thread_id: "codex_55",
          trace_id: null,
          started_at: "2026-05-05T06:39:43.287Z",
          last_seen_at: "2026-05-05T06:44:28.924Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");
    await stateStore.save({
      roles: [
        {
          threadId: "agent-dispatcher-idem",
          roleType: "agent-dispatcher",
          status: "active",
          config: buildAgentDispatcherConfig(dispatchPlanPath)
        }
      ],
      promptStore: {}
    });

    const killed: string[] = [];
    const killThread = async (threadId: string): Promise<void> => {
      killed.push(threadId);
    };

    await resolveDispatchPlanPathsFromState(stateStore, { killThread });
    const firstSweepKills = [...killed];

    await resolveDispatchPlanPathsFromState(stateStore, { killThread });
    expect(killed).toEqual(firstSweepKills);
  });

  it("includes active scheduler runs for watchdog reconciliation", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-index-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    const schedulerStatePath = path.join(directory, "scheduler_state.json");
    const stateStore = new StateStore(path.join(directory, "state.json"));

    await fs.writeFile(dispatchPlanPath, "# Dispatch Plan\n", "utf8");
    await fs.writeFile(schedulerStatePath, `${JSON.stringify({
      ...buildEmptyRunState(),
      status: "active_run",
      current_run_id: "run-001"
    }, null, 2)}\n`, "utf8");
    await stateStore.save({
      roles: [
        {
          threadId: "scheduler-active",
          roleType: "scheduler",
          status: "active",
          config: buildSchedulerConfig(dispatchPlanPath)
        }
      ],
      promptStore: {}
    });

    await expect(resolveDispatchPlanPathsFromState(stateStore)).resolves.toEqual([dispatchPlanPath]);
  });

  it("keeps an abandoned dispatcher in watchdog scope when a forgotten worker produced fresh expected_output after last_seen_at", async () => {
    // Scenario: the reconciler wrongly judged W-09 abandoned (hub idle + run-
    // tool transport stall + 30-min stale timeout) while codex_05 was still
    // alive. The codex CLI later finished and wrote the expected report file
    // after last_seen_at, so the worker really did complete. Without this
    // gate, `resolveSettledDispatchRowStatus` would still return "failed"
    // (worker.status=abandoned + plan=⚠️ ABANDONED), the role would settle
    // as terminal-failed, and the watchdog would stop reconciling — so the
    // `thread_missing:outputs_present → completed` transition never fires
    // and the entire dispatcher wedges. Observed on dispatcher 810b6be2.
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-index-forgotten-recovery-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    const reportPath = path.join(directory, "reports", "W-09.md");
    const stateStore = new StateStore(path.join(directory, "state.json"));

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| ⚠️ ABANDONED | 1 | W-09 | OBS-01 | CODEX | - | retry exhausted |"
    ].join("\n"), "utf8");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, "## Attempt 3\n\nimplementation delivered\n", "utf8");
    // Bump report mtime past last_seen_at to model "forgotten worker
    // accomplished the task after we wrote it off".
    const recoveredMs = Date.parse("2026-05-05T22:30:00.000Z");
    await fs.utimes(reportPath, recoveredMs / 1000, recoveredMs / 1000);
    await fs.writeFile(path.join(directory, "dispatch_threads.json"), `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "codex_01",
        started_at: "2026-05-05T21:42:51.459Z",
        status: "running"
      },
      workers: {
        "W-09": {
          thread_id: "codex_05",
          trace_id: null,
          started_at: "2026-05-05T21:42:51.470Z",
          last_seen_at: "2026-05-05T22:00:00.000Z",
          status: "abandoned",
          expected_outputs: [reportPath],
          hub_result: null,
          command_preamble: null,
          retry_count: 2
        }
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");
    await stateStore.save({
      roles: [
        {
          threadId: "agent-dispatcher-forgotten-recovery",
          roleType: "agent-dispatcher",
          status: "active",
          config: buildAgentDispatcherConfig(dispatchPlanPath)
        }
      ],
      promptStore: {}
    });

    // Must remain in watchdog scope so reconcile() can pick up the fresh
    // report via `thread_missing:outputs_present` and finalize the worker.
    await expect(resolveDispatchPlanPathsFromState(stateStore)).resolves.toEqual([dispatchPlanPath]);
    await expect(stateStore.load()).resolves.toMatchObject({
      roles: [
        {
          threadId: "agent-dispatcher-forgotten-recovery",
          status: "active"
        }
      ]
    });
  });

  it("settles a dispatcher whose only outstanding row is `completed` via force-complete (no validator score) — regression: agent-dispatcher-8eb13a31 V-01-A 2026-05-14", async () => {
    // Scenario: validator is enabled at the role level, every plan row is ✅,
    // every lifecycle worker is `status: completed`. One row reached
    // `completed` via a force-complete operator override (`update-status
    // --status completed` / `resume-worker --action force-complete` / PM
    // `pm_action: force_complete`), so `validation.last_score` is null.
    // Without trusting `worker.status === "completed"` as authoritative,
    // `isCompletedWorkerValidationSatisfied` returned false and the role
    // stayed `active` indefinitely after every other row settled normally.
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-index-force-complete-settle-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    const stateStore = new StateStore(path.join(directory, "state.json"));

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| ✅ | 1 | R-01 | impl | CODEX | - | normal validator pass |",
      "| ✅ | 2 | V-01-A | observation | CODEX | R-01 | force-completed via update-status |"
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(directory, "dispatch_threads.json"), `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "codex_01",
        started_at: "2026-05-14T05:00:00.000Z",
        status: "running"
      },
      workers: {
        "R-01": {
          thread_id: "codex_02",
          trace_id: null,
          started_at: "2026-05-14T05:01:00.000Z",
          last_seen_at: "2026-05-14T05:30:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          validation: {
            current_cycle: 1,
            max_fix_cycles: 5,
            validator_thread_id: "codex_validator_r01",
            last_score: 1,
            last_feedback: "pass",
            history: []
          }
        },
        "V-01-A": {
          thread_id: "codex_03",
          trace_id: null,
          started_at: "2026-05-14T06:55:00.000Z",
          last_seen_at: "2026-05-14T07:21:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          validation: {
            current_cycle: 0,
            max_fix_cycles: 5,
            validator_thread_id: null,
            last_score: null,
            last_feedback: null,
            history: []
          }
        }
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");
    await stateStore.save({
      roles: [
        {
          threadId: "agent-dispatcher-force-complete-settle",
          roleType: "agent-dispatcher",
          status: "active",
          config: AgentDispatcherConfigSchema.parse({
            dispatch_plan_path: dispatchPlanPath,
            command_file_path: path.join(directory, "dispatch_command.md"),
            dispatch_repo_root: directory,
            docs_root: directory,
            user_reply_channels: [{ channel: "web", chat_id: "web:ops" }],
            agent_type: "codex",
            mode: "bridge",
            kill_policy: "always",
            auto_approve: true,
            validator: {
              enabled: true,
              agent_type: "codex",
              model_id: "gpt-5.5 xhigh",
              mode: "stateless_call",
              auto_approve: false,
              threshold_type: "binary",
              pass_threshold: 0.7,
              max_fix_cycles: 5,
              base_branch: "main"
            }
          })
        }
      ],
      promptStore: {}
    });

    // Plan should NOT be returned for further reconciliation, and the role
    // should be flipped to terminal `completed`.
    await expect(resolveDispatchPlanPathsFromState(stateStore)).resolves.toEqual([]);
    await expect(stateStore.load()).resolves.toMatchObject({
      roles: [
        {
          threadId: "agent-dispatcher-force-complete-settle",
          status: "completed"
        }
      ]
    });
  });

  it("still settles an abandoned dispatcher when the expected_output mtime did not advance past last_seen_at", async () => {
    // Sanity check that the new recovery gate is scoped: a stale prior-
    // attempt artifact that has NOT been touched since last_seen_at must not
    // override the terminal settlement, otherwise abandoned dispatchers with
    // leftover artifacts would never settle.
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-index-no-fresh-output-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    const reportPath = path.join(directory, "reports", "W-09.md");
    const stateStore = new StateStore(path.join(directory, "state.json"));

    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| ⚠️ ABANDONED | 1 | W-09 | OBS-01 | CODEX | - | retry exhausted |"
    ].join("\n"), "utf8");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, "## Attempt 1 (stale)\n", "utf8");
    // mtime predates last_seen_at — this is a prior-attempt leftover, not
    // proof of recovery.
    const staleMs = Date.parse("2026-05-05T21:50:00.000Z");
    await fs.utimes(reportPath, staleMs / 1000, staleMs / 1000);
    await fs.writeFile(path.join(directory, "dispatch_threads.json"), `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "codex_01",
        started_at: "2026-05-05T21:42:51.459Z",
        status: "running"
      },
      workers: {
        "W-09": {
          thread_id: "codex_05",
          trace_id: null,
          started_at: "2026-05-05T21:42:51.470Z",
          last_seen_at: "2026-05-05T22:00:00.000Z",
          status: "abandoned",
          expected_outputs: [reportPath],
          hub_result: null,
          command_preamble: null,
          retry_count: 2
        }
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");
    await stateStore.save({
      roles: [
        {
          threadId: "agent-dispatcher-no-fresh-output",
          roleType: "agent-dispatcher",
          status: "active",
          config: buildAgentDispatcherConfig(dispatchPlanPath)
        }
      ],
      promptStore: {}
    });

    await expect(resolveDispatchPlanPathsFromState(stateStore)).resolves.toEqual([]);
    await expect(stateStore.load()).resolves.toMatchObject({
      roles: [
        {
          threadId: "agent-dispatcher-no-fresh-output",
          status: "failed"
        }
      ]
    });
  });
});

describe("hasStartupRecoverableDispatchWork", () => {
  it("does not reactivate a dispatcher that is waiting on a human gate", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-startup-human-gate-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| ✅ | 1 | V-01-A | Automated validation | CODEX | - | done |",
      "| ⬜ | 2 | V-01-B | Human launch review | HUMAN | V-01-A | waiting on operator |",
      "| ⬜ | 3 | N-16 | Lock launch contract | CODEX | V-01-B | blocked by human gate |"
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(directory, "dispatch_threads.json"), `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: "codex_01",
        started_at: "2026-05-05T21:42:51.459Z",
        status: "abandoned"
      },
      workers: {
        "V-01-A": {
          thread_id: "codex_174",
          trace_id: null,
          started_at: "2026-05-05T13:58:19.725Z",
          last_seen_at: "2026-05-05T14:08:06.869Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "DISPATCHER": {
          thread_id: "codex_01",
          trace_id: null,
          started_at: "2026-05-05T21:42:51.470Z",
          last_seen_at: "2026-05-05T21:43:17.761Z",
          status: "abandoned",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 2
        }
      },
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    await expect(hasStartupRecoverableDispatchWork(buildAgentDispatcherConfig(dispatchPlanPath))).resolves.toBe(false);
  });

  it("reactivates a dispatcher when automatic work is eligible", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "meridian-roles-startup-eligible-"));
    tempDirectories.add(directory);

    const dispatchPlanPath = path.join(directory, "dispatch_plan.md");
    await fs.writeFile(dispatchPlanPath, [
      "# Dispatch Plan",
      "",
      "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| ⬜ | 1 | N-01 | Ready automatic work | CODEX | - | ready |"
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(directory, "dispatch_threads.json"), `${JSON.stringify({
      version: 2,
      dispatcher: {
        thread_id: null,
        started_at: null,
        status: "pending"
      },
      workers: {},
      last_reconciled_at: null
    }, null, 2)}\n`, "utf8");

    await expect(hasStartupRecoverableDispatchWork(buildAgentDispatcherConfig(dispatchPlanPath))).resolves.toBe(true);
  });
});

function buildAgentDispatcherConfig(dispatchPlanPath: string) {
  return AgentDispatcherConfigSchema.parse({
    dispatch_plan_path: dispatchPlanPath,
    command_file_path: path.join(path.dirname(dispatchPlanPath), "dispatch_command.md"),
    dispatch_repo_root: path.dirname(dispatchPlanPath),
    docs_root: path.dirname(dispatchPlanPath),
    user_reply_channels: [{ channel: "web", chat_id: "web:ops" }],
    agent_type: "codex",
    mode: "bridge",
    kill_policy: "always",
    auto_approve: true
  });
}

function buildSchedulerConfig(dispatchPlanPath: string): SchedulerConfig {
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
    report_base_dir: path.join(directoryName(dispatchPlanPath), "reports"),
    catch_up_policy: "skip_missed"
  };
}

function directoryName(filePath: string): string {
  return path.dirname(filePath);
}
