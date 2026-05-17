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
  it("returns the full 27-indicator inventory and escalates red threshold crossings", async () => {
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

    const snapshot = await buildSystemMonitorSnapshot({
      stateStore: { load: async () => appStateWithDispatchers([fixtureA.planPath, fixtureB.planPath]) },
      processSnapshot: async () => processes,
      now: () => new Date("2026-05-18T02:48:33.000Z"),
      probeHub: async () => ({ reachable: true, latency_ms: 12 }),
      statFile: async (filePath) => {
        if (filePath.endsWith("state.json")) return { size: 11 * 1024 * 1024, mtimeMs: Date.parse("2026-05-18T02:48:30.000Z") };
        if (filePath.endsWith("meridian-roles.out.log")) return { size: 150 * 1024 * 1024, mtimeMs: Date.parse("2026-05-18T02:48:30.000Z") };
        return { size: 10 * 1024 * 1024, mtimeMs: Date.parse("2026-05-18T02:48:30.000Z") };
      },
      statFs: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024 }),
      countLogPatterns: async () => new Map([
        ["terminal_cleanup_kill_failed", 10],
        ["a2a_registration_retry", 31],
        ["validator_transport_stall", 6],
        ["pm_resolver_started", 5],
        ["watchdog_stall_detected", 51],
        ["launch_breaker_tripped", 3],
        ["worker_breaker_tripped", 3]
      ])
    });

    expect(snapshot.polled_at).toBe("2026-05-18T02:48:33.000Z");
    expect(snapshot.indicators).toHaveLength(27);
    expect(snapshot.any_red).toBe(true);

    expect(snapshot.indicators.find((i) => i.id === "A1")).toMatchObject({ value: 3, state: "red" });
    expect(snapshot.indicators.find((i) => i.id === "A2")).toMatchObject({ value: 130000, state: "red" });
    expect(snapshot.indicators.find((i) => i.id === "A4")).toMatchObject({ value: 1, state: "yellow" });
    expect(snapshot.indicators.find((i) => i.id === "C2")).toMatchObject({ value: 31, state: "red" });
    expect(snapshot.indicators.find((i) => i.id === "E2")).toMatchObject({ value: 1, state: "yellow" });
    expect(snapshot.indicators.find((i) => i.id === "E3")).toMatchObject({ value: 1, state: "yellow" });
    expect(snapshot.indicators.find((i) => i.id === "E4")).toMatchObject({ value: 1, state: "red" });
    expect(snapshot.indicators.find((i) => i.id === "E5")).toMatchObject({ value: 1, state: "info" });

    await fs.rm(fixtureA.dir, { recursive: true, force: true });
    await fs.rm(fixtureB.dir, { recursive: true, force: true });
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
