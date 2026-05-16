import { describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import path from "node:path";

import type { IncomingMessage, ServerResponse } from "node:http";

import type { AppState, DispatchThreadStateV2 } from "../../types";
import { createProcessHandlers, type ProcInfo } from "../process-handlers";

function makeResponse(): { res: ServerResponse; statusCode: () => number; body: () => string } {
  let captured = "";
  const harness: {
    statusCode: number;
    setHeader: (name: string, value: string | number | readonly string[]) => ServerResponse;
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

describe("createProcessHandlers /api/agentapi-processes", () => {
  it("returns 404-via-noop for unrelated routes", async () => {
    const handlers = createProcessHandlers({
      stateStore: { load: async () => ({ roles: [], promptStore: {} }) },
      listProcesses: () => []
    });
    const { res } = makeResponse();
    const handled = await handlers.handle(makeRequest("/api/something-else"), res);
    expect(handled).toBe(false);
  });

  it("returns an empty snapshot when no agentapi processes exist", async () => {
    const handlers = createProcessHandlers({
      stateStore: { load: async () => ({ roles: [], promptStore: {} }) },
      listProcesses: () => [
        { pid: 100, etime: "00:01", command: "/usr/bin/foo --bar" }
      ]
    });
    const { res, statusCode, body } = makeResponse();
    const handled = await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    expect(handled).toBe(true);
    expect(statusCode()).toBe(200);
    const payload = JSON.parse(body());
    expect(payload.total).toBe(0);
    expect(payload.processes).toEqual([]);
  });

  it("binds an agentapi process to the matching DISPATCHER row", async () => {
    const fixture = await createSidecarFixture({
      version: 2,
      dispatcher: {
        thread_id: "codex_42",
        started_at: "2026-05-16T10:00:00.000Z",
        status: "running"
      },
      workers: {},
      last_reconciled_at: null
    });

    const appState: AppState = {
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

    const handlers = createProcessHandlers({
      stateStore: { load: async () => appState },
      listProcesses: () => [
        { pid: 555, etime: "00:02:30", command: "agentapi server --socket=/tmp/agentapi-codex_42.sock --type=codex" }
      ]
    });
    const { res, statusCode, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    expect(statusCode()).toBe(200);
    const payload = JSON.parse(body());
    expect(payload.total).toBe(1);
    expect(payload.bound).toBe(1);
    expect(payload.leak).toBe(0);
    expect(payload.processes[0]).toMatchObject({
      pid: 555,
      thread_id: "codex_42",
      agent_type: "codex",
      binding: {
        dispatcher_role_id: "agent-dispatcher-abc",
        worker_id: "DISPATCHER",
        role: "dispatcher",
        status: "running"
      }
    });
  });

  it("flags as leak when no dispatcher claims the thread_id", async () => {
    const handlers = createProcessHandlers({
      stateStore: { load: async () => ({ roles: [], promptStore: {} }) },
      listProcesses: () => [
        { pid: 999, etime: "01:23", command: "agentapi server --socket=/tmp/agentapi-codex_99.sock --type=codex" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.leak).toBe(1);
    expect(payload.bound).toBe(0);
    expect(payload.processes[0].binding).toBeNull();
  });

  it("does not bind to completed workers (so their stale thread_id can't mask a leak)", async () => {
    const fixture = await createSidecarFixture({
      version: 2,
      dispatcher: {
        thread_id: null,
        started_at: null,
        status: "pending"
      },
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
    const appState: AppState = {
      roles: [
        {
          threadId: "agent-dispatcher-xyz",
          roleType: "agent-dispatcher",
          status: "active",
          config: {
            dispatcher_role_id: "agent-dispatcher-xyz",
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
    const handlers = createProcessHandlers({
      stateStore: { load: async () => appState },
      listProcesses: () => [
        { pid: 777, etime: "12:00", command: "agentapi server --socket=/tmp/agentapi-codex_77.sock --type=codex" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.leak).toBe(1);
    expect(payload.bound).toBe(0);
  });

  it("ignores non-agentapi processes", async () => {
    const handlers = createProcessHandlers({
      stateStore: { load: async () => ({ roles: [], promptStore: {} }) },
      listProcesses: () => [
        { pid: 100, etime: "00:01", command: "/usr/bin/node dist/index.js" },
        { pid: 200, etime: "00:01", command: "agentapi server --socket=/tmp/agentapi-x.sock" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    expect(payload.total).toBe(1);
  });

  it("sorts leaks ahead of bound entries", async () => {
    const handlers = createProcessHandlers({
      stateStore: { load: async () => ({ roles: [], promptStore: {} }) },
      listProcesses: () => [
        { pid: 100, etime: "00:01", command: "agentapi server --socket=/tmp/agentapi-codex_01.sock" },
        { pid: 200, etime: "00:01", command: "agentapi server --socket=/tmp/agentapi-codex_02.sock" }
      ]
    });
    const { res, body } = makeResponse();
    await handlers.handle(makeRequest("/api/agentapi-processes"), res);
    const payload = JSON.parse(body());
    // Both unbound → leak — order is by PID ascending
    expect(payload.processes.map((p: { pid: number }) => p.pid)).toEqual([100, 200]);
  });
});

// cleanup after all tests
import { afterAll } from "vitest";
afterAll(async () => {
  await Promise.all(
    Array.from(tempDirs, async (d) => {
      await fs.rm(d, { recursive: true, force: true });
    })
  );
  tempDirs.clear();
});
