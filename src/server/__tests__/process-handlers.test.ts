import { afterAll, describe, expect, it } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import path from "node:path";

import type { IncomingMessage, ServerResponse } from "node:http";

import type { AppState, DispatchThreadStateV2 } from "../../types";
import { _internals, createProcessHandlers, type ProcInfo } from "../process-handlers";
import { TokenUsageCollector, type TokenUsage } from "../token-usage";

function makeResponse(): { res: ServerResponse; statusCode: () => number; body: () => string } {
  let captured = "";
  const harness: {
    statusCode: number;
    setHeader: (n: string, v: string | number | readonly string[]) => ServerResponse;
    end: (payload?: string) => ServerResponse;
  } = {
    statusCode: 0,
    setHeader() { return harness as unknown as ServerResponse; },
    end(payload?: string) {
      captured = payload ?? "";
      return harness as unknown as ServerResponse;
    }
  };
  const res = harness as unknown as ServerResponse;
  return { res, statusCode: () => harness.statusCode, body: () => captured };
}

function makeRequest(url: string, method = "GET"): IncomingMessage {
  return { url, method } as unknown as IncomingMessage;
}

const tempDirs = new Set<string>();
async function createSidecarFixture(state: DispatchThreadStateV2): Promise<{ planPath: string; sidecarPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "process-handlers-test-"));
  tempDirs.add(dir);
  const planPath = path.join(dir, "dispatch_plan.md");
  await fs.writeFile(planPath, "# plan\n", "utf8");
  const sidecarPath = path.join(dir, "dispatch_threads.json");
  fsSync.writeFileSync(sidecarPath, JSON.stringify(state), "utf8");
  return { planPath, sidecarPath };
}

function emptyState(): AppState {
  return { roles: [], promptStore: {} };
}

function appStateWithDispatcher(fixture: { planPath: string }): AppState {
  return {
    roles: [
      {
        threadId: "agent-dispatcher-abc",
        roleType: "agent-dispatcher",
        status: "active",
        config: {
          dispatcher_role_id: "agent-dispatcher-abc",
          agent_type: "codex",
          mode: "bridge",
          auto_approve: false,
          dispatch_plan_path: fixture.planPath,
          command_file_path: path.join(path.dirname(fixture.planPath), "agent_dispatch_command.md"),
          dispatch_repo_root: path.dirname(fixture.planPath),
          kill_policy: "always",
          user_reply_channels: [{ channel: "telegram", chat_id: "telegram:test" }]
        }
      }
    ],
    promptStore: {}
  };
}

afterAll(async () => {
  await Promise.all(Array.from(tempDirs, async (d) => fs.rm(d, { recursive: true, force: true })));
  tempDirs.clear();
});

describe("/api/agentapi-processes — origin classification", () => {
  it("returns false for unrelated routes", async () => {
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      listProcesses: () => []
    });
    const { res } = makeResponse();
    expect(await handlers.handle(makeRequest("/api/foo"), res)).toBe(false);
  });

  it("classifies agentapi server as managed", async () => {
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      listProcesses: (): ProcInfo[] => [
        { pid: 500, ppid: 1, etime: "00:10", command: "agentapi server --socket=/tmp/agentapi-codex_42.sock --type=codex -- codex" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.processes[0].origin).toBe("managed");
    expect(payload.processes[0].agent_type).toBe("agentapi");
    expect(payload.processes[0].thread_id).toBe("codex_42");
  });

  it("classifies codex with agentapi PPID as managed (and inherits parent thread_id)", async () => {
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      listProcesses: (): ProcInfo[] => [
        { pid: 500, ppid: 1, etime: "00:10", command: "agentapi server --socket=/tmp/agentapi-codex_07.sock --type=codex -- codex" },
        { pid: 600, ppid: 500, etime: "00:09", command: "codex -c model_reasoning_effort=\"high\" --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    const codex = payload.processes.find((p: { agent_type: string }) => p.agent_type === "codex");
    expect(codex.origin).toBe("managed");
    expect(codex.thread_id).toBe("codex_07");
  });

  it("classifies codex spawned from a terminal as external (NOT a leak)", async () => {
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      listProcesses: (): ProcInfo[] => [
        { pid: 100, ppid: 1, etime: "10:00", command: "-zsh" },
        { pid: 101, ppid: 100, etime: "01:00", command: "node /Users/yzliu/.local/state/fnm_multishells/x/bin/codex" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.processes).toHaveLength(1);
    expect(payload.processes[0].origin).toBe("external");
    expect(payload.processes[0].is_leak).toBe(false);
    expect(payload.external).toBe(1);
    expect(payload.leak).toBe(0);
  });

  it("classifies user-launched codex (meridian-style flags BUT alive shell parent, not reparented) as external", async () => {
    // Live obs 2026-05-17: codex pid=8701 ppid=81108 with command
    // `node .../codex --dangerously-bypass-approvals-and-sandbox` was
    // misclassified as orphan because looksLikeMeridianOrphan matched the
    // --dangerously flag. The user runs codex manually with that flag too.
    // A real orphan reparents to PID=1; this one's chain leads to a live
    // -zsh, so it should be `external`, not `orphan`.
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      listProcesses: (): ProcInfo[] => [
        { pid: 81105, ppid: 1, etime: "10:00:00", command: "/Applications/iTerm.app/Contents/MacOS/iTerm2" },
        { pid: 81108, ppid: 81105, etime: "10:00:00", command: "-zsh" },
        { pid: 8701, ppid: 81108, etime: "08:59", command: "node /Users/yzliu/.local/state/fnm_multishells/81113/bin/codex --dangerously-bypass-approvals-and-sandbox" },
        { pid: 8702, ppid: 8701, etime: "08:59", command: "/Users/yzliu/.local/share/fnm/.../codex --dangerously-bypass-approvals-and-sandbox" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    const codex = payload.processes.filter((p: { agent_type: string }) => p.agent_type === "codex");
    expect(codex).toHaveLength(2);
    expect(codex.every((p: { origin: string }) => p.origin === "external")).toBe(true);
    expect(payload.external).toBe(2);
    expect(payload.orphan).toBe(0);
    expect(payload.leak).toBe(0);
  });

  it("classifies orphan codex with meridian-roles spawn markers (no agentapi parent) as orphan + leak", async () => {
    // Same scenario as the documented active-tool-process.ts:39 pattern:
    // agentapi parent died, codex CLI child reparented to PID 1.
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      listProcesses: (): ProcInfo[] => [
        { pid: 700, ppid: 1, etime: "12:00", command: "codex -c model_reasoning_effort=\"high\" --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.processes[0].origin).toBe("orphan");
    expect(payload.processes[0].is_leak).toBe(true);
    expect(payload.orphan).toBe(1);
    expect(payload.leak).toBe(1);
  });

  it("classifies interactive claude (no agentapi parent, no meridian-roles markers) as external", async () => {
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      listProcesses: (): ProcInfo[] => [
        { pid: 900, ppid: 1, etime: "06:00:00", command: "claude --dangerously-skip-permissions" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.processes[0].origin).toBe("external");
    expect(payload.processes[0].is_leak).toBe(false);
    expect(payload.external).toBe(1);
  });

  it("flags managed agentapi with no dispatcher claim as leak", async () => {
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      listProcesses: (): ProcInfo[] => [
        { pid: 999, ppid: 1, etime: "01:23", command: "agentapi server --socket=/tmp/agentapi-codex_99.sock --type=codex" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.processes[0].origin).toBe("managed");
    expect(payload.processes[0].is_leak).toBe(true);
    expect(payload.managed_leak).toBe(1);
  });

  it("binds managed agentapi to a DISPATCHER row", async () => {
    const fixture = await createSidecarFixture({
      version: 2,
      dispatcher: { thread_id: "codex_42", started_at: "2026-05-16T10:00:00.000Z", status: "running" },
      workers: {},
      last_reconciled_at: null
    });
    const handlers = createProcessHandlers({
      stateStore: { load: async () => appStateWithDispatcher(fixture) },
      listProcesses: (): ProcInfo[] => [
        { pid: 500, ppid: 1, etime: "00:10", command: "agentapi server --socket=/tmp/agentapi-codex_42.sock --type=codex" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.processes[0].is_leak).toBe(false);
    expect(payload.processes[0].binding).toMatchObject({
      dispatcher_role_id: "agent-dispatcher-abc",
      worker_id: "DISPATCHER",
      role: "dispatcher"
    });
    expect(payload.managed_bound).toBe(1);
    expect(payload.leak).toBe(0);
  });

  it("does not bind to a completed worker's stale thread_id (still treats matching agentapi as leak)", async () => {
    const fixture = await createSidecarFixture({
      version: 2,
      dispatcher: { thread_id: null, started_at: null, status: "pending" },
      workers: {
        "W-01": {
          thread_id: "codex_77",
          trace_id: null,
          started_at: "2026-05-15T00:00:00.000Z",
          last_seen_at: "2026-05-15T00:00:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });
    const handlers = createProcessHandlers({
      stateStore: { load: async () => appStateWithDispatcher(fixture) },
      listProcesses: (): ProcInfo[] => [
        { pid: 777, ppid: 1, etime: "12:00", command: "agentapi server --socket=/tmp/agentapi-codex_77.sock --type=codex" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.processes[0].is_leak).toBe(true);
    expect(payload.managed_leak).toBe(1);
  });

  // Regression: agent-dispatcher-00f759ff codex_15 was painted "no dispatcher
  // claim" while in awaiting_validation — but run-tool (tool-gateway/tools/
  // run.ts:335) intentionally keeps the worker thread alive in
  // running/awaiting_validation/fix_requested/blocked because the validator
  // may REJECT and the dispatcher delivers feedback to the SAME codex thread
  // (validator-orchestrator.ts:530) to reuse the rollout cache. The binding
  // index must mirror that liveness contract.
  it.each([
    ["awaiting_validation" as const],
    ["fix_requested" as const],
    ["blocked" as const]
  ])("binds a worker in %s status (its codex thread is intentionally still alive)", async (status) => {
    const fixture = await createSidecarFixture({
      version: 2,
      dispatcher: { thread_id: null, started_at: null, status: "pending" },
      workers: {
        "W-01": {
          thread_id: "codex_15",
          trace_id: null,
          started_at: "2026-05-17T00:00:00.000Z",
          last_seen_at: "2026-05-17T00:00:00.000Z",
          status,
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });
    const handlers = createProcessHandlers({
      stateStore: { load: async () => appStateWithDispatcher(fixture) },
      listProcesses: (): ProcInfo[] => [
        { pid: 1515, ppid: 1, etime: "00:30", command: "agentapi server --socket=/tmp/agentapi-codex_15.sock --type=codex" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.processes[0].is_leak).toBe(false);
    expect(payload.processes[0].binding).toMatchObject({
      dispatcher_role_id: "agent-dispatcher-abc",
      worker_id: "W-01",
      role: "worker",
      status
    });
    expect(payload.managed_bound).toBe(1);
    expect(payload.leak).toBe(0);
  });

  it("sorts leaks before managed-bound before external", async () => {
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      listProcesses: (): ProcInfo[] => [
        { pid: 100, ppid: 1, etime: "01:00", command: "claude --dangerously-skip-permissions" },        // external
        { pid: 200, ppid: 1, etime: "01:00", command: "agentapi server --socket=/tmp/agentapi-x.sock" }, // leak (no binding)
        { pid: 300, ppid: 1, etime: "01:00", command: "codex -c model_reasoning_effort=high --dangerously-bypass-approvals-and-sandbox" } // orphan leak
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    // Order: leaks (origin=managed-no-binding pid=200, origin=orphan pid=300), then external pid=100
    expect(payload.processes.map((p: { pid: number; is_leak: boolean }) => [p.pid, p.is_leak])).toEqual([
      [200, true],
      [300, true],
      [100, false]
    ]);
  });

  it("classifies codex parented to calling-hub as MANAGED, NOT a leak when thread_id is null (Hub-direct stateless call)", async () => {
    // Confirmed in Meridian/src/hub/router.ts:1185: Hub.handleSpawn ONLY
    // fires from inbound HubMessage { intent: "spawn" }. Hub does not
    // autonomously spawn. So a codex with PPID chain reaching the Hub was
    // REQUESTED by a caller — almost always meridian-roles' validator /
    // PM-resolver / launcher paths spawning `codex exec --json` for
    // stateless validator calls. These belong to meridian-roles; flagging
    // them external would hide spawn-loops that go through this pattern.
    //
    // No agentapi parent → no thread_id parseable from argv → unbound. The
    // pre-fix behavior flagged these as leaks (red), but Hub-direct
    // `codex exec --json` is BY DESIGN a transient stateless call (no
    // agentapi, no thread_id) — it self-reaps when the call finishes. The
    // operator's leak panel was overrun with this transient noise sitting
    // next to actual spawn-orphans (the codex_NN-bearing kind), and the
    // signal got drowned. Updated rule: only leak when thread_id is parseable
    // OR the row is agentapi itself.
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      listProcesses: (): ProcInfo[] => [
        { pid: 90810, ppid: 1, etime: "01:00", command: "node /Users/yzliu/work/Meridian/dist/hub/index.js" },
        { pid: 91163, ppid: 90810, etime: "00:15", command: "node /Users/yzliu/.local/share/fnm/aliases/default/bin/codex exec --json -c model_reasoning_effort=\"high\" --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox" },
        { pid: 91170, ppid: 91163, etime: "00:15", command: "/Users/yzliu/.local/share/fnm/node-versions/v24.13.1/installation/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex exec --json -c model_reasoning_effort=\"high\" --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.external).toBe(0);
    expect(payload.orphan).toBe(0);
    expect(payload.processes.filter((p: { origin: string }) => p.origin === "managed")).toHaveLength(2);
    expect(payload.processes.every((p: { thread_id: string | null }) => p.thread_id === null)).toBe(true);
    // Each codex row stays visible as managed, but no longer marked red.
    expect(payload.leak).toBe(0);
    expect(payload.managed_leak).toBe(0);
  });

  it("classifies hub-spawned codex as MANAGED when hub argv is the relative `node dist/hub/index.js`", async () => {
    // The live hub is launched from its own cwd (`/Users/yzliu/work/Meridian`),
    // so `ps` shows it without the absolute path — just `node dist/hub/index.js`.
    // Before MERIDIAN_HUB_RELATIVE_NODE_PATTERN, codex spawned by such a hub
    // failed the ancestor check and got tagged `orphan` (observed 2026-05-17
    // on PIDs 40502/40503 doing stateless validation for agent-dispatcher-67f6a3fc).
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      listProcesses: (): ProcInfo[] => [
        { pid: 38500, ppid: 1, etime: "10:00", command: "node dist/hub/index.js" },
        { pid: 40502, ppid: 38500, etime: "00:42", command: "node /Users/y/.local/share/fnm/aliases/default/bin/codex exec --json -c model_reasoning_effort=\"xhigh\" --model gpt-5.5 --sandbox read-only --skip-git-repo-check" },
        { pid: 40503, ppid: 40502, etime: "00:42", command: "/Users/y/.local/share/fnm/node-versions/v24.13.1/installation/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex exec --json -c model_reasoning_effort=\"xhigh\" --model gpt-5.5 --sandbox read-only --skip-git-repo-check" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.orphan).toBe(0);
    expect(payload.processes.filter((p: { origin: string }) => p.origin === "managed")).toHaveLength(2);
  });

  it("binds a Hub-direct current validator codex exec pair via the Hub PID index", async () => {
    // Regression for agent-dispatcher-00f759ff / BATCH-10-GATE: the live
    // validator runs as Hub-direct `codex exec --json`, so there is no agentapi
    // socket/parent in ps. The Hub instance registry maps the shim PID to
    // codex_03, while dispatch_threads.json stores that id on
    // validation.validator_thread_id until the verdict is recorded.
    const fixture = await createSidecarFixture({
      version: 2,
      dispatcher: { thread_id: "codex_01", started_at: "2026-05-17T08:56:40.631Z", status: "running" },
      workers: {
        "BATCH-10-GATE": {
          thread_id: "codex_02",
          trace_id: null,
          started_at: "2026-05-17T08:56:44.527Z",
          last_seen_at: "2026-05-17T09:04:02.953Z",
          status: "awaiting_validation",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          validation: {
            current_cycle: 0,
            max_fix_cycles: 3,
            validator_thread_id: "codex_03",
            last_score: null,
            last_feedback: null,
            history: [],
            spawn_failure_count: 0,
            last_spawn_failure_at: null
          }
        }
      },
      last_reconciled_at: null
    });
    const handlers = createProcessHandlers({
      stateStore: { load: async () => appStateWithDispatcher(fixture) },
      fetchAgentapiInstanceIndex: async () => new Map([[40502, "codex_03"]]),
      listProcesses: (): ProcInfo[] => [
        { pid: 38500, ppid: 1, etime: "10:00", command: "node dist/hub/index.js" },
        { pid: 40502, ppid: 38500, etime: "00:42", command: "node /Users/y/.local/share/fnm/aliases/default/bin/codex exec --json --sandbox read-only --skip-git-repo-check" },
        { pid: 40503, ppid: 40502, etime: "00:42", command: "/Users/y/.local/share/fnm/node-versions/v24.13.1/installation/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex exec --json --sandbox read-only --skip-git-repo-check" }
      ]
    });

    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    const codexRows = payload.processes.filter((p: { agent_type: string }) => p.agent_type === "codex");
    expect(codexRows).toHaveLength(2);
    expect(codexRows.every((p: { thread_id: string }) => p.thread_id === "codex_03")).toBe(true);
    expect(codexRows.every((p: { is_leak: boolean }) => p.is_leak === false)).toBe(true);
    expect(codexRows.every((p: { binding: { dispatcher_role_id: string; worker_id: string; role: string; status: string } }) =>
      p.binding?.dispatcher_role_id === "agent-dispatcher-abc"
      && p.binding?.worker_id === "BATCH-10-GATE"
      && p.binding?.role === "validator"
      && p.binding?.status === "running"
    )).toBe(true);
    expect(payload.managed_bound).toBe(2);
    expect(payload.leak).toBe(0);
  });

  it("binds streaming bridge codex exec pairs to live dispatcher and worker owners without Hub PID mapping", async () => {
    // Meridian streaming bridge instances intentionally have pid/socket_path
    // null in /api/instances. The live OS process is the per-run
    // `codex exec --json` child under the Hub, so the Processes tab must
    // recover ownership from lifecycle start times instead of treating these
    // sessioned bridge turns as stateless calls.
    const nowMs = Date.now();
    const dispatcherStartedAt = new Date(nowMs - 12 * 60 * 1000).toISOString();
    const workerStartedAt = new Date(nowMs - 3 * 60 * 1000).toISOString();
    const fixture = await createSidecarFixture({
      version: 2,
      dispatcher: { thread_id: "codex_01", started_at: dispatcherStartedAt, status: "running" },
      workers: {
        "DISPATCHER": {
          thread_id: "codex_01",
          trace_id: null,
          started_at: dispatcherStartedAt,
          last_seen_at: dispatcherStartedAt,
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        },
        "W-01": {
          thread_id: "codex_04",
          trace_id: null,
          started_at: workerStartedAt,
          last_seen_at: workerStartedAt,
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });
    const handlers = createProcessHandlers({
      stateStore: { load: async () => appStateWithDispatcher(fixture) },
      fetchAgentapiInstanceIndex: async () => new Map(),
      listProcesses: (): ProcInfo[] => [
        { pid: 38500, ppid: 1, etime: "30:00", command: "node /Users/yzliu/work/Meridian/dist/hub/index.js" },
        { pid: 42283, ppid: 38500, etime: "12:00", command: "node /Users/y/.local/share/fnm/aliases/default/bin/codex exec --json --dangerously-bypass-approvals-and-sandbox" },
        { pid: 42284, ppid: 42283, etime: "12:00", command: "/Users/y/.local/share/fnm/node-versions/v24.13.1/installation/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex exec --json --dangerously-bypass-approvals-and-sandbox" },
        { pid: 14442, ppid: 38500, etime: "03:00", command: "node /Users/y/.local/share/fnm/aliases/default/bin/codex exec --json -c model_reasoning_effort=\"xhigh\" --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox" },
        { pid: 14443, ppid: 14442, etime: "03:00", command: "/Users/y/.local/share/fnm/node-versions/v24.13.1/installation/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex exec --json -c model_reasoning_effort=\"xhigh\" --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox" }
      ]
    });

    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    const byPid = new Map<number, {
      thread_id: string | null;
      binding: { role: string; worker_id: string } | null;
      is_leak: boolean;
    }>(payload.processes.map((p: {
      pid: number;
      thread_id: string | null;
      binding: { role: string; worker_id: string } | null;
      is_leak: boolean;
    }) => [p.pid, p]));

    expect(byPid.get(42283)).toMatchObject({
      thread_id: "codex_01",
      binding: { role: "dispatcher", worker_id: "DISPATCHER" },
      is_leak: false
    });
    expect(byPid.get(42284)).toMatchObject({
      thread_id: "codex_01",
      binding: { role: "dispatcher", worker_id: "DISPATCHER" },
      is_leak: false
    });
    expect(byPid.get(14442)).toMatchObject({
      thread_id: "codex_04",
      binding: { role: "worker", worker_id: "W-01" },
      is_leak: false
    });
    expect(byPid.get(14443)).toMatchObject({
      thread_id: "codex_04",
      binding: { role: "worker", worker_id: "W-01" },
      is_leak: false
    });
    expect(payload.managed_bound).toBe(4);
    expect(payload.leak).toBe(0);
  });

  it("emits hub-registered streaming bridge threads with no live process as managed rows", async () => {
    // Streaming bridge instances stay registered in meridian-hub with
    // pid/socket_path null while idle between turns. The Processes tab is the
    // operator's "alive agent threads" view, so lifecycle-bound Hub threads
    // must remain visible even when no `codex exec --json` child is currently
    // present in `ps`.
    const dispatcherStartedAt = "2026-05-23T11:11:33.057Z";
    const workerStartedAt = "2026-05-23T11:12:01.522Z";
    const fixture = await createSidecarFixture({
      version: 2,
      dispatcher: { thread_id: "codex_67", started_at: dispatcherStartedAt, status: "running" },
      workers: {
        "PRE-FLIGHT": {
          thread_id: "codex_68",
          trace_id: null,
          started_at: workerStartedAt,
          last_seen_at: "2026-05-23T11:18:39.822Z",
          status: "blocked",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      last_reconciled_at: null
    });
    const handlers = createProcessHandlers({
      stateStore: { load: async () => appStateWithDispatcher(fixture) },
      listProcesses: (): ProcInfo[] => [],
      fetchAgentapiInstances: async () => [
        {
          thread_id: "codex_67",
          agent_type: "codex",
          mode: "bridge",
          socket_path: null,
          pid: null,
          status: "running",
          created_at: dispatcherStartedAt,
          restart_safe: true,
          auto_approve: true
        },
        {
          thread_id: "codex_68",
          agent_type: "codex",
          mode: "bridge",
          socket_path: null,
          pid: null,
          status: "running",
          created_at: workerStartedAt,
          restart_safe: true,
          auto_approve: true
        }
      ]
    });

    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    const byThread = new Map<string, {
      pid: number | null;
      origin: string;
      binding: { worker_id: string; role: string } | null;
      is_leak: boolean;
    }>(payload.processes.map((p: {
      thread_id: string;
      pid: number | null;
      origin: string;
      binding: { worker_id: string; role: string } | null;
      is_leak: boolean;
    }) => [p.thread_id, p]));

    expect(byThread.get("codex_67")).toMatchObject({
      pid: null,
      origin: "managed",
      binding: { worker_id: "DISPATCHER", role: "dispatcher" },
      is_leak: false
    });
    expect(byThread.get("codex_68")).toMatchObject({
      pid: null,
      origin: "managed",
      binding: { worker_id: "PRE-FLIGHT", role: "worker" },
      is_leak: false
    });
    expect(payload.total).toBe(2);
    expect(payload.managed_bound).toBe(2);
    expect(payload.leak).toBe(0);
  });

  it("emits unbound live Hub bridge threads instead of dropping them", async () => {
    // A live Meridian Hub bridge instance can be owned by another caller
    // (ADS) or by a Meridian-roles dispatcher that is no longer registered in
    // this service's state file. It still needs to show in the Processes tab
    // so operators can reconcile the Hub's active-thread count with the
    // roles-local lifecycle view.
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      listProcesses: (): ProcInfo[] => [],
      fetchAgentapiInstances: async () => [
        {
          thread_id: "codex_52",
          agent_type: "codex",
          mode: "bridge",
          socket_path: null,
          working_dir: "/Users/yzliu/work/Docs",
          pid: null,
          status: "running",
          created_at: "2026-05-23T10:14:05.881Z",
          restart_safe: true,
          auto_approve: false
        }
      ]
    });

    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());

    expect(payload.processes).toHaveLength(1);
    expect(payload.processes[0]).toMatchObject({
      pid: null,
      thread_id: "codex_52",
      origin: "hub",
      binding: null,
      is_leak: false
    });
    expect(payload.hub_managed).toBe(1);
    expect(payload.managed_bound).toBe(0);
    expect(payload.leak).toBe(0);
  });

  it("attributes live Hub streaming bridge codex resume processes to their Hub thread and keeps token_usage visible", async () => {
    // Streaming bridge instances are metadata-only in Meridian Hub
    // (pid/socket_path null). During a turn, Hub forks `codex exec ... --json`
    // as a child process. The Processes tab must attach that transient child
    // back to the Hub thread; otherwise operators see an idle-looking
    // hub-managed thread with no tokens, plus a separate anonymous stateless
    // process that actually carries the token total.
    const runStartedAt = new Date(Date.now() - 5_000).toISOString();
    const usage: TokenUsage = {
      source: "codex",
      input_tokens: 1234,
      cached_input_tokens: 100,
      output_tokens: 456,
      reasoning_output_tokens: 78,
      total_tokens: 1690,
      session_file: "/fake/.codex/sessions/2026/05/23/rollout-2026-05-23T10-00-00-019e3390-b9ef-70e2-a48c-96bb38c62574.jsonl",
      session_id: "019e3390-b9ef-70e2-a48c-96bb38c62574"
    };
    const stub: Pick<TokenUsageCollector, "lookup" | "retain"> = {
      lookup: (pid: number) => (pid === 1201 || pid === 1202) ? usage : null,
      retain: () => undefined
    };
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      tokenUsageCollector: stub as TokenUsageCollector,
      listProcesses: (): ProcInfo[] => [
        { pid: 1100, ppid: 1, etime: "10:00", command: "node /Users/yzliu/work/Meridian/dist/hub/index.js" },
        { pid: 1201, ppid: 1100, etime: "00:05", command: "node /Users/y/.local/share/fnm/aliases/default/bin/codex exec resume 019e3390-b9ef-70e2-a48c-96bb38c62574 --json --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox" },
        { pid: 1202, ppid: 1201, etime: "00:05", command: "/Users/y/.local/share/fnm/node-versions/v24.13.1/installation/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex exec resume 019e3390-b9ef-70e2-a48c-96bb38c62574 --json --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox" }
      ],
      fetchAgentapiInstances: async () => [
        {
          thread_id: "codex_52",
          agent_type: "codex",
          mode: "bridge",
          supportsStream: true,
          codexSessionId: "019e3390-b9ef-70e2-a48c-96bb38c62574",
          socket_path: null,
          working_dir: "/Users/yzliu/work",
          pid: null,
          status: "running",
          created_at: "2026-05-23T10:00:00.000Z",
          last_interaction_at: runStartedAt,
          restart_safe: true,
          auto_approve: true
        } as never
      ]
    });

    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    const byPid = new Map<number, {
      origin: string;
      thread_id: string | null;
      token_usage: TokenUsage | null;
      is_leak: boolean;
    }>(
      payload.processes
        .filter((p: { pid: number | null }) => p.pid !== null)
        .map((p: { pid: number; origin: string; thread_id: string | null; token_usage: TokenUsage | null; is_leak: boolean }) => [p.pid, p])
    );

    expect(payload.processes.find((p: { pid: number | null }) => p.pid === null)).toBeUndefined();
    expect(byPid.get(1201)).toMatchObject({
      origin: "hub",
      thread_id: "codex_52",
      is_leak: false,
      token_usage: { total_tokens: 1690 }
    });
    expect(byPid.get(1202)).toMatchObject({
      origin: "hub",
      thread_id: "codex_52",
      is_leak: false,
      token_usage: { total_tokens: 1690 }
    });
    expect(payload.token_totals).toMatchObject({
      sessions: 1,
      total_tokens: 1690
    });
  });

  it("also matches `tsx src/hub/index.ts` (dev-mode hub) as a hub ancestor", async () => {
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      listProcesses: (): ProcInfo[] => [
        { pid: 100, ppid: 1, etime: "10:00", command: "tsx src/hub/index.ts" },
        { pid: 200, ppid: 100, etime: "00:30", command: "node /Users/y/.local/share/fnm/aliases/default/bin/codex exec --json --dangerously-bypass-approvals-and-sandbox" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.processes.find((p: { agent_type: string }) => p.agent_type === "codex").origin).toBe("managed");
  });

  it("resolves thread_id for TCP-port agentapi via fetchAgentapiInstanceIndex", async () => {
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      listProcesses: (): ProcInfo[] => [
        { pid: 91030, ppid: 1, etime: "00:17", command: "/Users/yzliu/work/Meridian/bin/agentapi server --type=codex --port=56616 -- codex -c model_reasoning_effort=\"high\" --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox" },
        { pid: 91031, ppid: 91030, etime: "00:17", command: "codex -c model_reasoning_effort=\"high\" --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox" }
      ],
      fetchAgentapiInstanceIndex: async () => new Map([[91030, "codex_42"]])
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    const agentapi = payload.processes.find((p: { agent_type: string }) => p.agent_type === "agentapi");
    const codex = payload.processes.find((p: { agent_type: string }) => p.agent_type === "codex");
    expect(agentapi.thread_id).toBe("codex_42");
    // Codex child inherits via PPID-walk to the agentapi parent.
    expect(codex.thread_id).toBe("codex_42");
  });

  it("agentapi without socket marker AND no Hub instance index → still managed, flagged as leak", async () => {
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      listProcesses: (): ProcInfo[] => [
        { pid: 91030, ppid: 1, etime: "00:17", command: "/Users/yzliu/work/Meridian/bin/agentapi server --type=codex --port=56616 -- codex --dangerously-bypass-approvals-and-sandbox" }
      ]
      // no fetchAgentapiInstanceIndex
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.processes[0].origin).toBe("managed");
    expect(payload.processes[0].thread_id).toBeNull();
    expect(payload.processes[0].is_leak).toBe(true);  // managed with no binding = leak
  });

  it("attaches token_usage to codex entries via the collector and dedupes shim+native in token_totals", async () => {
    const usage: TokenUsage = {
      source: "codex",
      input_tokens: 18222,
      cached_input_tokens: 7552,
      output_tokens: 625,
      reasoning_output_tokens: 511,
      total_tokens: 18847,
      session_file: "/fake/.codex/sessions/2026/05/17/rollout-x.jsonl",
      session_id: "sess-x"
    };
    // Stub collector: returns the same TokenUsage for both shim and native;
    // null for agentapi (matching reality — only codex processes carry it).
    const stub: Pick<TokenUsageCollector, "lookup" | "retain"> = {
      lookup: (pid: number) => (pid === 34386 || pid === 34387) ? usage : null,
      retain: () => undefined
    };
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      tokenUsageCollector: stub as TokenUsageCollector,
      listProcesses: (): ProcInfo[] => [
        { pid: 34385, ppid: 1, etime: "00:30", command: "agentapi server --socket=/tmp/agentapi-codex_01.sock --type=codex -- codex" },
        { pid: 34386, ppid: 34385, etime: "00:30", command: "node /Users/y/.local/share/fnm/aliases/default/bin/codex --dangerously-bypass-approvals-and-sandbox" },
        { pid: 34387, ppid: 34386, etime: "00:30", command: "/Users/y/.local/share/fnm/.../codex-darwin-arm64/.../codex/codex --dangerously-bypass-approvals-and-sandbox" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    const byPid = new Map<number, { token_usage: TokenUsage | null }>(
      payload.processes.map((p: { pid: number; token_usage: TokenUsage | null }) => [p.pid, p])
    );
    expect(byPid.get(34385)?.token_usage).toBeNull();             // agentapi has none
    expect(byPid.get(34386)?.token_usage?.total_tokens).toBe(18847); // shim
    expect(byPid.get(34387)?.token_usage?.total_tokens).toBe(18847); // native
    // Shim + native point to the same session_file, so totals dedupe to one
    // session and one set of cumulative numbers.
    expect(payload.token_totals).toEqual({
      input_tokens: 18222,
      cached_input_tokens: 7552,
      output_tokens: 625,
      reasoning_output_tokens: 511,
      total_tokens: 18847,
      sessions: 1
    });
  });

  it("token_totals is zero/empty when no codex/claude processes carry usage", async () => {
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      tokenUsageCollector: null,
      listProcesses: (): ProcInfo[] => [
        { pid: 500, ppid: 1, etime: "00:10", command: "agentapi server --socket=/tmp/agentapi-codex_42.sock --type=codex -- codex" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.token_totals.sessions).toBe(0);
    expect(payload.token_totals.total_tokens).toBe(0);
  });

  it("summarizeTokenUsage dedupes by session_file across multiple snapshot rows", () => {
    const u1: TokenUsage = {
      source: "codex",
      input_tokens: 10, cached_input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 12,
      session_file: "/a", session_id: "a"
    };
    const u2: TokenUsage = {
      source: "claude",
      input_tokens: 5, cached_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0, total_tokens: 8,
      session_file: "/b", session_id: "b"
    };
    const totals = _internals.summarizeTokenUsage([
      // two rows pointing at /a (shim + native) — counted once
      { token_usage: u1 } as never,
      { token_usage: u1 } as never,
      { token_usage: u2 } as never,
      { token_usage: null } as never
    ]);
    expect(totals).toEqual({
      input_tokens: 15,
      cached_input_tokens: 1,
      output_tokens: 5,
      reasoning_output_tokens: 0,
      total_tokens: 20,
      sessions: 2
    });
  });

  it("binds pm_resolver row via issue.worker_id when top-level worker_id is absent (production shape)", async () => {
    // Production recording paths (startPmResolverForRole /
    // recordPmResolverResult) never set a top-level `worker_id` on the
    // pm_resolvers[] entry — the target worker lives at `issue.worker_id`.
    // Pre-fix, buildThreadIndex only read `pm.worker_id` so EVERY live
    // pm_resolver displayed as `worker: "(unknown)"`, making the Processes
    // tab unreadable for the canonical PM-running-against-blocked-worker
    // scenario. Observed live on agent-dispatcher-98b73906 codex_05
    // resolving PRE-FLIGHT.
    const fixture = await createSidecarFixture({
      version: 2,
      dispatcher: { thread_id: "claude_02", started_at: "2026-05-18T18:41:41.697Z", status: "running" },
      workers: {
        "PRE-FLIGHT": {
          thread_id: "codex_04",
          trace_id: null,
          started_at: "2026-05-18T18:42:11.461Z",
          last_seen_at: "2026-05-18T18:42:11.461Z",
          status: "blocked",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0
        }
      },
      pm_resolvers: [
        {
          thread_id: "codex_05",
          status: "running",
          started_at: "2026-05-18T18:46:35.409Z",
          last_seen_at: "2026-05-18T18:53:35.462Z",
          agent_type: "codex",
          model_id: "gpt-5.5 xhigh",
          mode: "bridge",
          auto_approve: true,
          issue: {
            status: "manual_intervention_required",
            worker_id: "PRE-FLIGHT",
            message: "PRE-FLIGHT reported blocking outcome",
            error: null,
            source: "dispatcher"
          },
          result: null,
          error: null,
          transport_error: "run failed: Request timed out — the hub may be overloaded.",
          marker_outcome: null,
          marker_pm_action: null
        }
      ],
      last_reconciled_at: null
    } as unknown as DispatchThreadStateV2);
    const handlers = createProcessHandlers({
      stateStore: { load: async () => appStateWithDispatcher(fixture) },
      listProcesses: (): ProcInfo[] => [
        { pid: 63585, ppid: 1, etime: "10:00", command: "agentapi server --socket=/tmp/agentapi-codex_05.sock --type=codex -- codex --model gpt-5.5" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.processes[0].binding).toMatchObject({
      dispatcher_role_id: "agent-dispatcher-abc",
      worker_id: "PRE-FLIGHT",
      role: "pm_resolver",
      status: "running"
    });
    expect(payload.processes[0].is_leak).toBe(false);
  });

  it("does NOT flag thread_id-less Hub-direct codex/claude as leaks (they self-reap; only agentapi or thread_id-bearing rows can leak)", async () => {
    // Mirrors the openclaw-h20-user-visible incident: 5 leak rows visible
    // in the Processes tab, 3 of which were Hub-direct stateless calls
    // (codex exec --json / claude --print) with no thread_id. Those are
    // legitimate transient work and should NOT be red. Compare against an
    // unbindable agentapi in the same snapshot, which IS still a leak.
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      listProcesses: (): ProcInfo[] => [
        { pid: 54988, ppid: 1, etime: "20:00", command: "node /Users/yzliu/work/Meridian/dist/hub/index.js" },
        // Hub-direct stateless codex (no thread_id, no binding) — was a leak pre-fix
        { pid: 64893, ppid: 54988, etime: "03:07", command: "node /Users/yzliu/.local/share/fnm/aliases/default/bin/codex exec --json --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox" },
        { pid: 64894, ppid: 64893, etime: "03:07", command: "/Users/yzliu/.local/share/fnm/node-versions/v24.13.1/installation/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex exec --json --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox" },
        // Hub-direct stateless claude (no thread_id, no binding) — was a leak pre-fix
        { pid: 99659, ppid: 54988, etime: "08:01", command: "claude --print --output-format stream-json --verbose --include-partial-messages --allowedTools Bash Edit Replace --dangerously-skip-permissions" },
        // Unbindable agentapi (no socket marker, no fetchAgentapiInstanceIndex wired) — STILL a leak
        { pid: 91030, ppid: 1, etime: "00:17", command: "/Users/yzliu/work/Meridian/bin/agentapi server --type=codex --port=56616 -- codex --dangerously-bypass-approvals-and-sandbox" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    const byPid = new Map<number, { is_leak: boolean; thread_id: string | null; agent_type: string | null }>(
      payload.processes.map((p: { pid: number; is_leak: boolean; thread_id: string | null; agent_type: string | null }) => [p.pid, p])
    );
    // Hub-direct stateless calls: NOT leaks (the fix's whole point)
    expect(byPid.get(64893)?.is_leak).toBe(false);
    expect(byPid.get(64894)?.is_leak).toBe(false);
    expect(byPid.get(99659)?.is_leak).toBe(false);
    // Unbindable agentapi: still a leak (agentapi without a thread_id is broken regardless)
    expect(byPid.get(91030)?.is_leak).toBe(true);
    expect(byPid.get(91030)?.agent_type).toBe("agentapi");
    // Total leak count is 1 (the agentapi), not 4 (was 4 pre-fix).
    expect(payload.leak).toBe(1);
  });

  it("strips token_usage from unbound rows that resolve to the same session_file as a bound row (claude shared-cwd collision)", async () => {
    // Two claude processes both write to ~/.claude/projects/<encoded-cwd>/
    // and the resolver picks the closest-birthtime jsonl. When one claude is
    // agentapi-managed (bound to claude_NN DISPATCHER) and a sibling
    // Hub-direct `claude --print` started near the same time in the same
    // cwd, the resolver maps BOTH to the bound peer's session file →
    // unbound row inherits the bound row's 1.69M token total visually.
    // The summarizeTokenUsage already dedupes the sum; this strips the
    // misleading per-row display so the per-process numbers add up to the
    // displayed total.
    const sharedUsage: TokenUsage = {
      source: "claude",
      input_tokens: 100,
      cached_input_tokens: 50,
      output_tokens: 200,
      reasoning_output_tokens: 0,
      total_tokens: 300,
      session_file: "/Users/y/.claude/projects/-Users-yzliu-work/abc.jsonl",
      session_id: "claude-sess-abc"
    };
    const fixture = await createSidecarFixture({
      version: 2,
      dispatcher: { thread_id: "claude_02", started_at: "2026-05-18T18:41:41.697Z", status: "running" },
      workers: {},
      last_reconciled_at: null
    });
    const stub: Pick<TokenUsageCollector, "lookup" | "retain"> = {
      // Both the bound (99656) and the Hub-direct sibling (99659) resolve
      // to the same session file via cwd+birthtime collision.
      lookup: (pid: number) => (pid === 99656 || pid === 99659) ? sharedUsage : null,
      retain: () => undefined
    };
    const handlers = createProcessHandlers({
      stateStore: { load: async () => appStateWithDispatcher(fixture) },
      tokenUsageCollector: stub as TokenUsageCollector,
      listProcesses: (): ProcInfo[] => [
        { pid: 54988, ppid: 1, etime: "20:00", command: "node /Users/yzliu/work/Meridian/dist/hub/index.js" },
        { pid: 99655, ppid: 1, etime: "08:01", command: "agentapi server --socket=/tmp/agentapi-claude_02.sock --type=claude" },
        { pid: 99656, ppid: 99655, etime: "08:01", command: "claude --print --output-format stream-json --verbose --include-partial-messages" },
        // Hub-direct claude --print: NOT a child of the agentapi above
        { pid: 99659, ppid: 54988, etime: "08:01", command: "claude --print --output-format stream-json --verbose --include-partial-messages --allowedTools Bash Edit Replace --dangerously-skip-permissions" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    const byPid = new Map<number, { token_usage: TokenUsage | null; binding: unknown }>(
      payload.processes.map((p: { pid: number; token_usage: TokenUsage | null; binding: unknown }) => [p.pid, p])
    );
    // The bound DISPATCHER claude keeps its real total.
    expect(byPid.get(99656)?.binding).not.toBeNull();
    expect(byPid.get(99656)?.token_usage?.total_tokens).toBe(300);
    // The Hub-direct sibling is unbound and was sharing the same session_file;
    // its token_usage is now nulled so the totals are not double-displayed.
    expect(byPid.get(99659)?.binding).toBeNull();
    expect(byPid.get(99659)?.token_usage).toBeNull();
    // The aggregate is unaffected (was already deduping by session_file).
    expect(payload.token_totals.sessions).toBe(1);
    expect(payload.token_totals.total_tokens).toBe(300);
  });

  it("binds the active validator_thread_id even when worker status is no longer 'awaiting_validation' (output-artifact recovery + transport-stall paths)", async () => {
    // Pre-fix: buildThreadIndex required `w.status === "awaiting_validation"`
    // before it would publish a binding for `worker.validation.validator_thread_id`.
    // Two real scenarios fall outside that gate:
    //  (a) output-artifact recovery flips the worker to `completed` while the
    //      stateless_call validator (still spawned by validator-orchestrator)
    //      is mid-flight on its own thread_id;
    //  (b) `validator_run_transport_stall_codex_alive` keeps the validator's
    //      thread_id recorded on a `blocked` worker for late-verdict recovery.
    // In both cases the codex process is still alive, the dispatcher knows
    // which worker it belongs to, but the Processes tab used to leave it
    // unbound and dump it into the stateless bucket — making the operator
    // misread the validator as a phantom "stateless call".
    const fixture = await createSidecarFixture({
      version: 2,
      dispatcher: { thread_id: "codex_01", started_at: "2026-05-21T14:00:00.000Z", status: "running" },
      workers: {
        "A2": {
          thread_id: "codex_05",
          trace_id: null,
          started_at: "2026-05-21T14:07:01.000Z",
          last_seen_at: "2026-05-21T14:10:00.000Z",
          status: "completed",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          validation: {
            validator_thread_id: "codex_08",
            current_cycle: 0,
            last_score: null,
            last_feedback: null,
            history: [],
            spawn_failure_count: 0,
            last_spawn_failure_at: null
          }
        }
      },
      pm_resolvers: [],
      last_reconciled_at: null
    } as unknown as DispatchThreadStateV2);
    const handlers = createProcessHandlers({
      stateStore: { load: async () => appStateWithDispatcher(fixture) },
      listProcesses: (): ProcInfo[] => [
        { pid: 7001, ppid: 1, etime: "10:00", command: "agentapi server --socket=/tmp/agentapi-codex_08.sock --type=codex -- codex --model gpt-5.5" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.processes[0].binding).toMatchObject({
      worker_id: "A2",
      role: "validator",
      status: "running"
    });
    expect(payload.processes[0].is_leak).toBe(false);
  });

  it("binds an unbound stateless `codex exec --json` to the worker's active validator when exactly one candidate matches by timing (singleton fallback)", async () => {
    // Meridian Hub spawns validators in stateless_call mode as
    // `codex exec --json` and does NOT publish the thread_id via /api/list, so
    // fetchAgentapiInstanceIndex returns no PID mapping. The lifecycle store
    // knows the validator_thread_id, but the Processes tab cannot resolve
    // it from `ps` alone. This test exercises the inference fallback in
    // buildSnapshot: when exactly one active stateless owner exists in the
    // lifecycle AND exactly one unbound `codex exec --json` root is present
    // in the snapshot, bind them. The native binary child of the root
    // inherits the binding so both PIDs fold into the worker's group.
    const fixture = await createSidecarFixture({
      version: 2,
      dispatcher: { thread_id: "codex_01", started_at: "2026-05-21T14:00:00.000Z", status: "running" },
      workers: {
        "A2": {
          thread_id: "codex_05",
          trace_id: null,
          started_at: "2026-05-21T14:07:01.000Z",
          last_seen_at: "2026-05-21T14:09:50.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          validation: {
            validator_thread_id: "codex_08",
            current_cycle: 0,
            last_score: null,
            last_feedback: null,
            history: [],
            spawn_failure_count: 0,
            last_spawn_failure_at: null
          }
        }
      },
      pm_resolvers: [],
      last_reconciled_at: null
    } as unknown as DispatchThreadStateV2);
    // No Hub instance index entry for the stateless PIDs — this is the live
    // Hub contract we observed (`codex exec --json` calls do not register).
    const handlers = createProcessHandlers({
      stateStore: { load: async () => appStateWithDispatcher(fixture) },
      fetchAgentapiInstanceIndex: async () => new Map<number, string>(),
      listProcesses: (): ProcInfo[] => [
        // meridian-hub parent (present in ps so the stateless calls have a
        // managed-origin classification path).
        { pid: 91564, ppid: 1, etime: "30:00", command: "node /Users/yzliu/work/Meridian/dist/hub/index.js" },
        // The stateless `codex exec --json` shim + its native binary child.
        { pid: 90194, ppid: 91564, etime: "00:05", command: "node /Users/yzliu/.local/share/fnm/aliases/default/bin/codex exec --json -c model_reasoning_effort=\"high\" --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox" },
        { pid: 90195, ppid: 90194, etime: "00:05", command: "/Users/yzliu/.local/share/fnm/node-versions/v24.13.1/installation/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex exec --json -c model_reasoning_effort=\"high\" --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    const ninetyEightFour = payload.processes.find((p: { pid: number }) => p.pid === 90194);
    const ninetyEightFive = payload.processes.find((p: { pid: number }) => p.pid === 90195);
    expect(ninetyEightFour.binding).toMatchObject({
      worker_id: "A2",
      role: "validator",
      status: "running"
    });
    expect(ninetyEightFour.thread_id).toBe("codex_08");
    // The native binary child of the stateless root must inherit the
    // binding so the page can fold all PIDs into the worker's group.
    expect(ninetyEightFive.binding).toMatchObject({
      worker_id: "A2",
      role: "validator"
    });
    expect(ninetyEightFive.thread_id).toBe("codex_08");
    expect(ninetyEightFour.is_leak).toBe(false);
    expect(ninetyEightFive.is_leak).toBe(false);
  });

  it("inference pass does NOT bind when multiple stateless candidates exist (avoids false 1-to-1 attribution under concurrent validators)", async () => {
    // Safety property: when two `codex exec --json` roots exist and only one
    // active stateless owner is recorded, we cannot decide which root the
    // owner belongs to. Both must stay unbound; the operator sees the
    // ambiguity rather than a wrong attribution.
    const fixture = await createSidecarFixture({
      version: 2,
      dispatcher: { thread_id: "codex_01", started_at: "2026-05-21T14:00:00.000Z", status: "running" },
      workers: {
        "A2": {
          thread_id: "codex_05",
          trace_id: null,
          started_at: "2026-05-21T14:07:01.000Z",
          last_seen_at: "2026-05-21T14:09:50.000Z",
          status: "running",
          expected_outputs: [],
          hub_result: null,
          command_preamble: null,
          retry_count: 0,
          validation: {
            // started_at on the worker is well outside the TOLERANCE_MS
            // window for BOTH candidate processes; without a timestamp match
            // the singleton fallback would not fire either (because there
            // are TWO candidates), so binding must stay null.
            validator_thread_id: "codex_08",
            current_cycle: 0,
            last_score: null,
            last_feedback: null,
            history: [],
            spawn_failure_count: 0,
            last_spawn_failure_at: null
          }
        }
      },
      pm_resolvers: [],
      last_reconciled_at: null
    } as unknown as DispatchThreadStateV2);
    const handlers = createProcessHandlers({
      stateStore: { load: async () => appStateWithDispatcher(fixture) },
      fetchAgentapiInstanceIndex: async () => new Map<number, string>(),
      listProcesses: (): ProcInfo[] => [
        { pid: 91564, ppid: 1, etime: "30:00", command: "node /Users/yzliu/work/Meridian/dist/hub/index.js" },
        // Two distinct stateless `codex exec --json` roots.
        { pid: 90194, ppid: 91564, etime: "00:05", command: "node /usr/local/bin/codex exec --json --model gpt-5.5" },
        { pid: 90195, ppid: 90194, etime: "00:05", command: "/usr/local/lib/codex/codex exec --json --model gpt-5.5" },
        { pid: 90294, ppid: 91564, etime: "00:05", command: "node /usr/local/bin/codex exec --json --model gpt-5.5" },
        { pid: 90295, ppid: 90294, etime: "00:05", command: "/usr/local/lib/codex/codex exec --json --model gpt-5.5" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    for (const pid of [90194, 90195, 90294, 90295]) {
      const row = payload.processes.find((p: { pid: number }) => p.pid === pid);
      expect(row.binding, `pid ${pid} should remain unbound under ambiguity`).toBeNull();
    }
  });

  it("ignores non-agent processes entirely (zsh, node-not-codex, ...)", async () => {
    const handlers = createProcessHandlers({
      stateStore: { load: async () => emptyState() },
      listProcesses: (): ProcInfo[] => [
        { pid: 1, ppid: 0, etime: "10:00:00", command: "/sbin/launchd" },
        { pid: 2, ppid: 1, etime: "10:00:00", command: "-zsh" },
        { pid: 3, ppid: 1, etime: "10:00:00", command: "/opt/homebrew/opt/node/bin/node /opt/homebrew/lib/node_modules/openclaw/dist/index.js" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.total).toBe(0);
    expect(payload.processes).toEqual([]);
  });
});
