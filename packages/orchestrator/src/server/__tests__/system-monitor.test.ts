import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AppState, DispatchThreadStateV2 } from "../../types";
import {
  buildSystemMonitorSnapshot,
  createSystemMonitorHandlers,
  type SystemMonitorProcess
} from "../system-monitor";

function tokenUsage(total: number): SystemMonitorProcess["token_usage"] {
  return {
    input_tokens: total,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: total,
    session_id: `session-${total}`,
    session_file: `/tmp/session-${total}.jsonl`,
    source: "codex"
  };
}

async function createDispatcherFixture(
  state: DispatchThreadStateV2,
  planMarkdown = [
    "| Status | Batch | Worker | Task | Model | Depends_on |",
    "| --- | --- | --- | --- | --- | --- |",
    "| ✅ | 1 | W-1 | done | CODEX | |",
    "| ⬜ | 1 | HUMAN-1 | gate | HUMAN | W-1 |"
  ].join("\n")
): Promise<{ dir: string; planPath: string }> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "system-monitor-test-"));
  const planPath = path.join(dir, "dispatch_plan.md");
  await fs.writeFile(planPath, `${planMarkdown}\n`, "utf8");
  await fs.writeFile(path.join(dir, "dispatch_threads.json"), JSON.stringify(state), "utf8");
  return { dir, planPath };
}

function appStateWithDispatchers(planPaths: string[]): AppState {
  return {
    roles: planPaths.map((planPath, index) => ({
      threadId: `agent-dispatcher-${index}`,
      roleType: "agent-dispatcher",
      status: index === 0 ? "active" : "paused",
      config: {
        dispatcher_role_id: `agent-dispatcher-${index}`,
        dispatch_plan_path: planPath,
        command_file_path: path.join(path.dirname(planPath), "agent_dispatch_command.md"),
        dispatch_repo_root: path.dirname(planPath),
        agent_type: "codex",
        mode: "bridge",
        kill_policy: "always",
        auto_approve: true,
        user_reply_channels: [{ channel: "web", chat_id: "web:test" }],
        validator: {
          enabled: true,
          agent_type: "codex",
          mode: "stateless_call",
          auto_approve: false,
          threshold_type: "score",
          pass_threshold: 0.7,
          max_fix_cycles: 3,
          base_branch: "main"
        }
      }
    })),
    promptStore: {}
  };
}

describe("buildSystemMonitorSnapshot", () => {
  it("returns the full 39-indicator inventory and escalates red threshold crossings", async () => {
    const oldIso = "2026-05-18T01:00:00.000Z";
    const fixtureA = await createDispatcherFixture({
      version: 2,
      dispatcher: { thread_id: "shared-running-thread", started_at: oldIso, status: "running" },
      workers: {
        "W-1": {
          thread_id: "completed-thread",
          trace_id: null,
          started_at: oldIso,
          last_seen_at: oldIso,
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "W-2": {
          thread_id: "blocked-thread",
          trace_id: null,
          started_at: oldIso,
          last_seen_at: oldIso,
          status: "blocked",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "W-3": {
          thread_id: "awaiting-thread",
          trace_id: null,
          started_at: oldIso,
          last_seen_at: oldIso,
          status: "awaiting_validation",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          validation: {
            current_cycle: 1,
            max_fix_cycles: 3,
            validator_thread_id: null,
            last_score: null,
            last_feedback: null,
            history: []
          }
        }
      },
      last_reconciled_at: null
    });
    const fixtureB = await createDispatcherFixture({
      version: 2,
      dispatcher: { thread_id: null, started_at: null, status: "pending" },
      workers: {
        "W-X": {
          thread_id: "shared-running-thread",
          trace_id: null,
          started_at: oldIso,
          last_seen_at: oldIso,
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    }, [
      "| Status | Batch | Worker | Task | Model | Depends_on |",
      "| --- | --- | --- | --- | --- | --- |",
      "| 🔄 | 1 | W-X | running | CODEX | |"
    ].join("\n"));

    const processes: SystemMonitorProcess[] = [
      {
        pid: 100,
        ppid: 1,
        etime: "10:00",
        agent_type: "codex",
        thread_id: "completed-thread",
        origin: "orphan",
        binding: null,
        is_leak: true,
        command: "codex",
        token_usage: tokenUsage(60_000)
      },
      {
        pid: 101,
        ppid: 1,
        etime: "09:00",
        agent_type: "claude",
        thread_id: null,
        origin: "orphan",
        binding: null,
        is_leak: true,
        command: "claude",
        token_usage: tokenUsage(70_000)
      },
      {
        pid: 102,
        ppid: 1,
        etime: "08:00",
        agent_type: "codex",
        thread_id: null,
        origin: "managed",
        binding: null,
        is_leak: true,
        command: "agentapi server",
        token_usage: null
      }
    ];

    let timingNow = 1_000;
    const snapshot = await buildSystemMonitorSnapshot({
      stateStore: { load: async () => appStateWithDispatchers([fixtureA.planPath, fixtureB.planPath]) },
      processSnapshot: async () => processes,
      now: () => new Date("2026-05-18T02:48:33.000Z"),
      measureNow: () => {
        const value = timingNow;
        timingNow += 675;
        return value;
      },
      probeHub: async () => ({ reachable: true, latency_ms: 12 }),
      statFile: async (filePath) => {
        if (filePath.endsWith("state.json")) return { size: 11 * 1024 * 1024, mtimeMs: Date.parse("2026-05-18T02:48:30.000Z") };
        if (filePath.endsWith("meridian-roles.out.log")) return { size: 150 * 1024 * 1024, mtimeMs: Date.parse("2026-05-18T02:48:30.000Z") };
        if (filePath.endsWith("fnm_multishells")) return { size: 2 * 1024 * 1024, mtimeMs: Date.parse("2026-05-18T02:48:30.000Z") };
        return { size: 10 * 1024 * 1024, mtimeMs: Date.parse("2026-05-18T02:48:30.000Z") };
      },
      statFs: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
      countLogPatterns: async (filePath: string) => {
        // The system monitor scans the roles log (lifecycle_*, watchdog_*, etc.)
        // and the hub log (rehydrate_*, is_not_registered_post_hub_init) on
        // every snapshot. Mock returns different counts based on which file
        // was requested so we can assert per-card wiring independently.
        if (filePath.endsWith("hub.log")) {
          return new Map([
            ["rehydrate_orphan_reaped", 2],
            ["rehydrate_probe_succeeded_after_retry", 7],
            ["rehydrate_pid_dead_pruned", 4],
            ["is_not_registered_post_hub_init", 0]
          ]);
        }
        return new Map([
          ["terminal_cleanup_kill_failed", 10],
          ["a2a_registration_retry", 31],
          ["validator_transport_stall", 6],
          ["pm_resolver_started", 5],
          ["watchdog_stall_detected", 51],
          ["launch_breaker_tripped", 3],
          ["worker_breaker_tripped", 3],
          ["lifecycle_auto_force_complete", 12]
        ]);
      }
    });

    expect(snapshot.polled_at).toBe("2026-05-18T02:48:33.000Z");
    expect(snapshot.indicators).toHaveLength(39);
    expect(snapshot.any_red).toBe(true);

    // C8 — emitted-once-per-(plan, worker) signal that a dispatcher's PM
    // resolver is exhausted (failed or completed-and-escalated). No fixture
    // log lines were planted for it here, so value is 0 / green.
    expect(snapshot.indicators.find((i) => i.id === "C8")).toMatchObject({
      group: "loop_detectors",
      name: "Dispatcher PM-resolver exhausted (awaiting human)",
      unit: "events",
      value: 0,
      state: "green",
      source_learning: "dispatcher/watchdog-pm-resolver-exhausted-self-loop.md"
    });

    // D6 fixture: 2 MB fnm_multishells block (above 1 MB yellow, below 10 MB red)
    expect(snapshot.indicators.find((i) => i.id === "D6")).toMatchObject({
      group: "system_resources",
      name: "fnm multishells dir block size",
      unit: "bytes",
      value: 2 * 1024 * 1024,
      state: "yellow",
      thresholds: { yellow: 1024 * 1024, red: 10 * 1024 * 1024 },
      source_learning: "maintenance-hub-restart-pm2-and-socket-race.md"
    });

    expect(snapshot.indicators.find((i) => i.id === "G1")).toMatchObject({
      group: "cure_metrics",
      name: "Auto-force-complete events (24h)",
      unit: "events",
      value: 12,
      state: "info"
    });
    expect(snapshot.indicators.find((i) => i.id === "G2")).toMatchObject({
      group: "cure_metrics",
      name: "Rehydrate orphan reaped (24h)",
      unit: "events",
      value: 2,
      state: "info",
      source_learning: "storm-recurrence-architectural-root-cause.md"
    });
    expect(snapshot.indicators.find((i) => i.id === "G3")).toMatchObject({
      group: "cure_metrics",
      name: "Rehydrate probe succeeded after retry (24h)",
      unit: "events",
      value: 7,
      state: "info"
    });
    expect(snapshot.indicators.find((i) => i.id === "G4")).toMatchObject({
      group: "cure_metrics",
      name: "Rehydrate PID-dead pruned (24h)",
      unit: "events",
      value: 4,
      state: "info"
    });
    expect(snapshot.indicators.find((i) => i.id === "E7")).toMatchObject({
      group: "lifecycle_anomaly",
      name: "\"is not registered\" within 60s of hub restart",
      unit: "events",
      value: 0,
      state: "green",
      thresholds: { yellow: 1, red: 5 }
    });

    expect(snapshot.indicators.find((i) => i.id === "A1")).toMatchObject({ value: 3, state: "red" });
    expect(snapshot.indicators.find((i) => i.id === "A2")).toMatchObject({ value: 130000, state: "red" });
    expect(snapshot.indicators.find((i) => i.id === "A4")).toMatchObject({ value: 1, state: "yellow" });
    expect(snapshot.indicators.find((i) => i.id === "C2")).toMatchObject({ value: 31, state: "red" });
    expect(snapshot.indicators.find((i) => i.id === "E2")).toMatchObject({ value: 1, state: "yellow" });
    expect(snapshot.indicators.find((i) => i.id === "E3")).toMatchObject({ value: 1, state: "yellow" });
    expect(snapshot.indicators.find((i) => i.id === "E4")).toMatchObject({ value: 1, state: "red" });
    expect(snapshot.indicators.find((i) => i.id === "E5")).toMatchObject({ value: 1, state: "yellow" });
    expect(snapshot.indicators.find((i) => i.id === "E6")).toMatchObject({ value: 0, state: "green" });
    expect(snapshot.indicators.find((i) => i.id === "F2")).toMatchObject({ value: 1, state: "info" });
    expect(snapshot.indicators.find((i) => i.id === "H1")).toMatchObject({
      group: "monitor_self",
      name: "Process snapshot token enrichment",
      value: "custom",
      state: "info",
      source_learning: "token-usage-orphan-pid-rollout-fanout-storm.md"
    });
    expect(snapshot.indicators.find((i) => i.id === "H2")).toMatchObject({
      group: "monitor_self",
      name: "System monitor snapshot latency",
      unit: "ms",
      value: 675,
      state: "yellow",
      thresholds: { yellow: 500, red: 2000 },
      source_learning: "token-usage-orphan-pid-rollout-fanout-storm.md"
    });

    expect(snapshot.indicators.find((i) => i.id === "A1")?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "pid 100 codex", detail: expect.stringContaining("completed-thread") }),
      expect.objectContaining({ label: "pid 101 claude" })
    ]));
    expect(snapshot.indicators.find((i) => i.id === "A4")?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "pid 100 codex", detail: expect.stringContaining("completed-thread") })
    ]));
    expect(snapshot.indicators.find((i) => i.id === "E2")?.items).toEqual([
      expect.objectContaining({
        label: "agent-dispatcher-0 / W-2",
        href: "/role/agent-dispatcher-0",
        detail: expect.stringContaining("blocked-thread")
      })
    ]);
    expect(snapshot.indicators.find((i) => i.id === "E3")?.items).toEqual([
      expect.objectContaining({
        label: "agent-dispatcher-0 / W-3",
        href: "/role/agent-dispatcher-0",
        detail: expect.stringContaining("awaiting-thread")
      })
    ]);
    expect(snapshot.indicators.find((i) => i.id === "E4")?.items).toEqual([
      expect.objectContaining({
        label: "thread shared-running-thread",
        detail: expect.stringContaining("agent-dispatcher-0")
      })
    ]);
    expect(snapshot.indicators.find((i) => i.id === "E5")?.items).toEqual([
      expect.objectContaining({ label: "agent-dispatcher-0", href: "/role/agent-dispatcher-0" })
    ]);
    expect(snapshot.indicators.find((i) => i.id === "F2")?.items).toEqual([
      expect.objectContaining({ label: "agent-dispatcher-1", href: "/role/agent-dispatcher-1" })
    ]);
    // D5 detects the hub-log probe storm (see hub-list-zombie-eviction-and-probe-storm.md):
    // with no shared runtime the growth rate is zero, so green. Wiring check.
    expect(snapshot.indicators.find((i) => i.id === "D5")).toMatchObject({
      group: "system_resources",
      name: "meridian hub log growth rate",
      unit: "bytes/s",
      value: 0,
      state: "green",
      source_learning: "hub-list-zombie-eviction-and-probe-storm.md"
    });
    expect(snapshot.indicators.find((i) => i.id === "F3")?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "agent-dispatcher-0", href: "/role/agent-dispatcher-0" }),
      expect.objectContaining({ label: "agent-dispatcher-1", href: "/role/agent-dispatcher-1" })
    ]));

    await fs.rm(fixtureA.dir, { recursive: true, force: true });
    await fs.rm(fixtureB.dir, { recursive: true, force: true });
  });

  it("flags E6 when a BLOCKED HUMAN row has pending non-HUMAN downstream (v1.1-append dep-loop)", async () => {
    // Reproducer for agent-dispatcher-98b73906 (2026-05-19): V-01-B was a
    // HUMAN gate marked ⛔ after failed verification, and the appended fix
    // rows F-6/F-7 were wired `depends_on: V-01-B`. Result: a deadlock
    // where the dispatcher idles forever because the HUMAN row never
    // reaches a terminal lifecycle status on its own. E6 must catch this
    // even when the dispatcher is paused (restart hold).
    const fixture = await createDispatcherFixture(
      {
        version: 2,
        dispatcher: { thread_id: null, started_at: null, status: "pending" },
        workers: {},
        last_reconciled_at: null
      },
      [
        "| Status | Batch | Worker | Task | Model | Depends_on |",
        "| --- | --- | --- | --- | --- | --- |",
        "| ✅ | 1 | V-01-A | rebuild | CODEX | |",
        "| ⛔ | 1 | V-01-B | human verify | HUMAN | V-01-A |",
        "| ⬜ | 2 | F-6 | fix finding | CODEX | V-01-B |",
        "| ⬜ | 2 | F-7 | fix finding | CODEX | V-01-B |",
        "| ⬜ | 3 | POST-FLIGHT | teardown | CODEX | ALL-PRIOR |"
      ].join("\n")
    );

    const snapshot = await buildSystemMonitorSnapshot({
      stateStore: { load: async () => appStateWithDispatchers([fixture.planPath]) },
      processSnapshot: async () => [],
      now: () => new Date("2026-05-19T12:00:00.000Z"),
      probeHub: async () => ({ reachable: true, latency_ms: 12 }),
      statFile: async () => null,
      statFs: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
      countLogPatterns: async () => new Map()
    });

    const e6 = snapshot.indicators.find((i) => i.id === "E6");
    expect(e6).toMatchObject({ value: 1, state: "red" });
    expect(e6?.items).toEqual([
      expect.objectContaining({
        label: "agent-dispatcher-0",
        href: "/role/agent-dispatcher-0",
        detail: expect.stringContaining("V-01-B")
      })
    ]);
    // The downstream chain (F-6, F-7, and POST-FLIGHT via ALL-PRIOR) must all
    // be listed so the operator sees the full set of pending workers stuck
    // behind the gate.
    expect(e6?.items?.[0]?.detail).toContain("F-6");
    expect(e6?.items?.[0]?.detail).toContain("F-7");
    expect(e6?.items?.[0]?.detail).toContain("POST-FLIGHT");

    await fs.rm(fixture.dir, { recursive: true, force: true });
  });

  it("builds its default process snapshot with token enrichment disabled", async () => {
    const snapshot = await buildSystemMonitorSnapshot({
      stateStore: { load: async () => ({ roles: [], promptStore: {} }) },
      listProcesses: () => [
        {
          pid: 110,
          ppid: 1,
          etime: "00:20",
          command: "/Users/yzliu/.openclaw/npm/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex app-server --listen stdio://"
        }
      ],
      now: () => new Date("2026-05-23T05:00:00.000Z"),
      measureNow: () => 10,
      probeHub: async () => ({ reachable: true, latency_ms: 8 }),
      statFile: async () => null,
      statFs: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
      countLogPatterns: async () => new Map()
    });

    expect(snapshot.indicators.find((i) => i.id === "H1")).toMatchObject({
      value: "disabled",
      state: "green",
      detail: expect.stringContaining("does not run per-process ps/lsof lookups")
    });
    expect(snapshot.indicators.find((i) => i.id === "A5")).toMatchObject({
      value: 1,
      state: "green"
    });
    expect(snapshot.indicators.find((i) => i.id === "A2")).toMatchObject({
      value: "skipped",
      state: "info"
    });
    expect(snapshot.indicators.find((i) => i.id === "A3")).toMatchObject({
      value: "skipped",
      state: "info"
    });
  });

  it("keeps the API read-only and returns false for unrelated routes", async () => {
    const handlers = createSystemMonitorHandlers({
      stateStore: { load: async () => ({ roles: [], promptStore: {} }) },
      processSnapshot: async () => [],
      probeHub: async () => ({ reachable: false, latency_ms: null }),
      statFile: async () => null,
      statFs: async () => ({ freeBytes: 0 }),
      countLogPatterns: async () => new Map()
    });

    expect(await handlers.handle({ method: "POST", url: "/api/system-monitor" } as never, {} as never)).toBe(false);
    expect(await handlers.handle({ method: "GET", url: "/api/other" } as never, {} as never)).toBe(false);
  });
});
