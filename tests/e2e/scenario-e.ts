import * as fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { A2AClient } from "../../src/a2a/client";
import { A2AServer } from "../../src/a2a/server";
import { DispatcherRole } from "../../src/roles/definitions";
import { PromptStore } from "../../src/roles/prompt-store";
import { RoleRegistry } from "../../src/roles/role-registry";
import { RoleRunner } from "../../src/roles/role-runner";
import { createPromptHandlers, type PromptHandlers } from "../../src/server/prompt-handlers";
import { createRoleHandlers, type RoleHandlers } from "../../src/server/role-handlers";
import { StateStore } from "../../src/state-store";
import { AppStateSchema, HubMessageSchema, type AgentInstance, type AppState, type HubMessage, type HubResult } from "../../src/types";

const idleInstances: AgentInstance[] = [
  {
    thread_id: "claude_01",
    agent_type: "claude",
    model_id: "opus",
    mode: "bridge",
    socket_path: "/tmp/claude.sock",
    working_dir: "/tmp",
    pid: 101,
    tmux_pane: null,
    status: "idle",
    created_at: "2026-03-19T00:00:00.000Z",
    restart_safe: true,
    auto_approve: false
  },
  {
    thread_id: "codex_01",
    agent_type: "codex",
    model_id: "gpt-5-codex",
    mode: "bridge",
    socket_path: "/tmp/codex.sock",
    working_dir: "/tmp",
    pid: 202,
    tmux_pane: null,
    status: "idle",
    created_at: "2026-03-19T00:00:00.000Z",
    restart_safe: true,
    auto_approve: false
  }
];

describe("Scenario E: Socket channel routing", () => {
  it("PASS", async () => {
    const harness = await startHarness();

    try {
      await harness.requestJson("POST", "/api/role", {
        thread_id: "dispatcher-e",
        user_reply_channel: {
          channel: "telegram",
          chat_id: "telegram:routing"
        },
        tasks: [
          {
            task_id: "socket-check",
            instruction: "Verify the reply socket",
            depends_on: [],
            target_thread_id: "claude_01"
          }
        ]
      });

      const dispatch = await waitForHubMessage(
        harness.hub,
        (message) => message.intent === "run" && message.payload.content === "Verify the reply socket"
      );
      expect(dispatch.reply_channel).toMatchObject({
        channel: "socket",
        chat_id: "service:meridian-roles",
        socket_path: harness.rolesSocketPath
      });
      expect(dispatch.suppress_reply).toBe(false);

      await harness.hub.sendResult(dispatch, {
        source: "claude",
        content: "Socket route OK"
      });

      await vi.waitFor(async () => {
        const state = await harness.readState();
        const role = state.roles.find((entry) => entry.threadId === "dispatcher-e");
        expect(role?.status).toBe("completed");
      }, { timeout: 10_000 });

      const state = await harness.readState();
      const role = state.roles.find((entry) => entry.threadId === "dispatcher-e");
      const config = role?.config as { tasks?: Array<{ result_trace_id?: string; status: string }> };
      expect(config.tasks?.[0]?.status).toBe("done");
      expect(config.tasks?.[0]?.result_trace_id).toBe(dispatch.trace_id);

      const detail = await harness.requestJson<{
        tasks: Array<{ trace_id?: string; status: string }>;
      }>("GET", "/api/role/dispatcher-e");
      expect(detail.tasks[0]?.status).toBe("done");
      expect(detail.tasks[0]?.trace_id).toBe(dispatch.trace_id.slice(0, 8));
    } finally {
      await harness.close();
    }
  });
});

interface HarnessOptions {
  baseDir?: string;
  cleanupDirOnClose?: boolean;
}

interface ScenarioHarness {
  hub: FakeHub;
  rolesSocketPath: string;
  requestJson<T>(method: string, url: string, body?: unknown): Promise<T>;
  readState(): Promise<AppState>;
  close(): Promise<void>;
}

interface FakeHub {
  messages: HubMessage[];
  sendResult(message: HubMessage, overrides?: Partial<HubResult>): Promise<void>;
  close(): Promise<void>;
}

async function startHarness(options: HarnessOptions = {}): Promise<ScenarioHarness> {
  const baseDir = options.baseDir ?? await fs.mkdtemp("/tmp/meridian-roles-scenario-e-");
  const cleanupDirOnClose = options.cleanupDirOnClose ?? !options.baseDir;
  const hubSocketPath = path.join(baseDir, "hub.sock");
  const rolesSocketPath = path.join(baseDir, "roles.sock");
  const stateFilePath = path.join(baseDir, "state.json");
  const log = createLogger();
  const hub = await startFakeHub(hubSocketPath);
  const client = new A2AClient({
    hubSocketPath,
    rolesSocketPath,
    connectTimeoutMs: 500,
    responseTimeoutMs: 2_000,
    retryBaseDelayMs: 25,
    maxRetryDelayMs: 100,
    log
  });
  const stateStore = new StateStore(stateFilePath);
  const registry = new RoleRegistry();

  registry.register("dispatcher", (threadId, config) => new DispatcherRole(threadId, config, { stateStore, rolesSocketPath }));

  const runner = new RoleRunner({
    sendToHub: (message) => client.send(message),
    listInstances: () => idleInstances,
    log
  });
  const roleHandlers = createRoleHandlers({
    runner,
    registry,
    stateStore,
    log
  });
  const promptStore = new PromptStore({
    stateStore,
    resolveRole: roleHandlers.resolveRole
  });
  const promptHandlers = createPromptHandlers(promptStore);
  const resultServer = new A2AServer((result) => runner.dispatch(result), {
    socketPath: rolesSocketPath,
    log
  });

  await resultServer.listen();
  await client.start();

  return {
    hub,
    rolesSocketPath,
    requestJson: (method, url, body) => invokeJson(roleHandlers, promptHandlers, method, url, body),
    async readState(): Promise<AppState> {
      return readStateFile(stateFilePath);
    },
    async close(): Promise<void> {
      await Promise.allSettled([
        client.stop(),
        resultServer.close(),
        hub.close()
      ]);

      if (cleanupDirOnClose) {
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    }
  };
}

async function startFakeHub(socketPath: string): Promise<FakeHub> {
  const messages: HubMessage[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let raw = "";

    socket.on("data", (chunk: string) => {
      raw += chunk;
    });

    socket.on("end", () => {
      void handleMessage(socket, raw);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    messages,
    sendResult: async (message, overrides = {}) => {
      if (message.reply_channel.channel !== "socket" || !message.reply_channel.socket_path) {
        throw new Error("Expected a socket reply_channel");
      }

      await sendSocketPayload(message.reply_channel.socket_path, {
        trace_id: overrides.trace_id ?? message.trace_id,
        thread_id: overrides.thread_id ?? message.thread_id,
        source: overrides.source ?? inferSource(message.target),
        status: overrides.status ?? "success",
        content: overrides.content ?? "ok",
        attachments: overrides.attachments ?? [],
        timestamp: overrides.timestamp ?? new Date().toISOString()
      });
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await fs.unlink(socketPath).catch(() => undefined);
    }
  };

  async function handleMessage(socket: net.Socket, raw: string): Promise<void> {
    const message = HubMessageSchema.parse(JSON.parse(raw));
    messages.push(message);

    if (message.intent === "register_service") {
      socket.end(JSON.stringify({
        trace_id: message.trace_id,
        thread_id: message.thread_id,
        source: "codex",
        status: "success",
        content: "registered",
        attachments: [],
        timestamp: new Date().toISOString()
      }));
      return;
    }

    socket.end();
  }
}

async function sendSocketPayload(socketPath: string, result: HubResult): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(socketPath, () => {
          socket.end(JSON.stringify(result));
        });

        socket.once("close", () => resolve());
        socket.once("error", reject);
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw lastError;
}

async function waitForHubMessage(hub: FakeHub, predicate: (message: HubMessage) => boolean): Promise<HubMessage> {
  await vi.waitFor(() => {
    expect(hub.messages.some(predicate)).toBe(true);
  }, { timeout: 10_000 });

  return hub.messages.find(predicate) as HubMessage;
}

async function invokeJson<T>(
  roleHandlers: RoleHandlers,
  promptHandlers: PromptHandlers,
  method: string,
  url: string,
  body?: unknown
): Promise<T> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const request = Object.assign(Readable.from(payload ? [payload] : []), {
    method,
    url,
    headers: payload ? { "content-type": "application/json" } : {}
  });
  const response = createMockResponse();

  const handledByPrompt = await promptHandlers.handle(request as never, response as never);
  if (!handledByPrompt) {
    const handledByRole = await roleHandlers.handle(request as never, response as never);
    if (!handledByRole) {
      throw new Error(`Unhandled route: ${method} ${url}`);
    }
  }

  const text = response.body.trim();
  const parsed = text ? JSON.parse(text) : null;
  if (response.statusCode >= 400) {
    throw new Error(typeof parsed?.error === "string" ? parsed.error : `HTTP ${response.statusCode}`);
  }

  return parsed as T;
}

async function readStateFile(stateFilePath: string): Promise<AppState> {
  const raw = await fs.readFile(stateFilePath, "utf8");
  return AppStateSchema.parse(JSON.parse(raw));
}

function createLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}

function inferSource(target: string): "claude" | "codex" | "gemini" | "cursor" {
  if (target.includes("claude")) {
    return "claude";
  }
  if (target.includes("gemini")) {
    return "gemini";
  }
  if (target.includes("cursor")) {
    return "cursor";
  }
  return "codex";
}

function createMockResponse(): {
  body: string;
  statusCode: number;
  headersSent: boolean;
  setHeader(name: string, value: string): void;
  end(chunk?: string | Buffer): void;
} {
  return {
    body: "",
    statusCode: 200,
    headersSent: false,
    setHeader() {
      this.headersSent = true;
    },
    end(chunk) {
      this.headersSent = true;
      if (chunk !== undefined) {
        this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      }
    }
  };
}
