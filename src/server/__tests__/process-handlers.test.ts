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

  it("classifies codex parented to calling-hub as MANAGED (Hub-direct spawn from meridian-roles)", async () => {
    // Confirmed in Meridian/src/hub/router.ts:1185: Hub.handleSpawn ONLY
    // fires from inbound HubMessage { intent: "spawn" }. Hub does not
    // autonomously spawn. So a codex with PPID chain reaching the Hub was
    // REQUESTED by a caller — almost always meridian-roles' validator /
    // PM-resolver / launcher paths spawning `codex exec --json` for
    // stateless validator calls. These belong to meridian-roles; flagging
    // them external would hide spawn-loops that go through this pattern.
    //
    // No agentapi parent → no thread_id parseable from argv → unbound →
    // is_leak=true. Operator sees them surface in red; if the hold is in
    // effect they shouldn't be spawning at all.
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
    // Both codex have a Hub ancestor → managed (not external, not orphan).
    // No agentapi → no thread_id → unbound → leak (operator should see).
    expect(payload.external).toBe(0);
    expect(payload.orphan).toBe(0);
    expect(payload.processes.filter((p: { origin: string }) => p.origin === "managed")).toHaveLength(2);
    expect(payload.leak).toBe(2);
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
