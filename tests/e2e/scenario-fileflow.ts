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

describe("Scenario Fileflow: dispatcher calls two agents sequentially", () => {
  it("PASS (writes step1 then final using claude -> codex)", async () => {
    const harness = await startFileflowHarness();

    try {
      const { taskInstructionA, taskInstructionB, inputPath, step1Path, finalPath, auditPath, recordPath, runId } = harness;

      // Initialize input file that agent A must read.
      await fs.mkdir(path.dirname(inputPath), { recursive: true });
      await fs.writeFile(inputPath, "input: Meridian-roles\n", "utf8");
      await fs.writeFile(auditPath, "", "utf8");

      const created = await harness.requestJson<{ ok: true; thread_id: string }>("POST", "/api/role", {
        thread_id: `dispatcher-fileflow-${runId}`,
        user_reply_channel: {
          channel: "telegram",
          chat_id: "telegram:fileflow"
        },
        tasks: [
          {
            task_id: "A",
            instruction: taskInstructionA,
            depends_on: [],
            target_thread_id: "claude_01"
          },
          {
            task_id: "B",
            instruction: taskInstructionB,
            depends_on: ["A"],
            target_agent_type: "codex"
          }
        ]
      });

      expect(created.thread_id).toBe(`dispatcher-fileflow-${runId}`);

      await vi.waitFor(async () => {
        const state = await harness.readState();
        const role = state.roles.find((entry) => entry.threadId === `dispatcher-fileflow-${runId}`);
        expect(role?.status).toBe("completed");
      }, { timeout: 10_000 });

      const [step1, final, auditRaw] = await Promise.all([
        fs.readFile(step1Path, "utf8"),
        fs.readFile(finalPath, "utf8"),
        fs.readFile(auditPath, "utf8")
      ]);

      expect(step1).toBe("step1: input: Meridian-roles\n");
      expect(final).toBe("final: step1: input: Meridian-roles\n");

      const auditLines = auditRaw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      expect(auditLines).toEqual([
        `claude:A read=${inputPath} write=${step1Path}`,
        `codex:B read=${step1Path} write=${finalPath}`
      ]);

      const summaryRecord = [
        `# Dispatcher Fileflow Success Record`,
        ``,
        `Run id: ${runId}`,
        `Dispatcher thread: dispatcher-fileflow-${runId}`,
        ``,
        `## Task A (claude_01)`,
        `Instruction:`,
        "```",
        taskInstructionA,
        "```",
        ``,
        `## Task B (codex_01 via target_agent_type=codex)`,
        `Instruction:`,
        "```",
        taskInstructionB,
        "```",
        ``,
        `## Output verification`,
        ``,
        `- step1Path: ${step1Path}`,
        "```",
        step1,
        "```",
        ``,
        `- finalPath: ${finalPath}`,
        "```",
        final,
        "```",
        ``,
        `## Agent audit (read/write trace)`,
        "```",
        auditRaw,
        "```"
      ].join("\n");

      await fs.mkdir(path.dirname(recordPath), { recursive: true });
      await fs.writeFile(recordPath, summaryRecord, "utf8");

      // Also assert completion summary got sent to the user reply channel.
      await vi.waitFor(() => {
        const summary = harness.hub.messages.find((m) => m.intent === "reply" && m.target === "global");
        expect(summary).toBeDefined();
      }, { timeout: 5_000 });
    } finally {
      await harness.close();
    }
  });
});

type FileflowHarness = {
  hub: FakeHub;
  requestJson<T>(method: string, pathname: string, body?: unknown): Promise<T>;
  readState(): Promise<AppState>;
  close(): Promise<void>;

  runId: string;
  inputPath: string;
  step1Path: string;
  finalPath: string;
  auditPath: string;
  recordPath: string;

  taskInstructionA: string;
  taskInstructionB: string;
};

interface FakeHub {
  messages: HubMessage[];
  close(): Promise<void>;
}

async function startFileflowHarness(): Promise<FileflowHarness> {
  const repoRoot = path.resolve(__dirname, "../..");
  const runId = `fileflow-${cryptoLikeId()}`;

  const baseDir = await fs.mkdtemp("/tmp/meridian-roles-fileflow-");
  const hubSocketPath = path.join(baseDir, "hub.sock");
  const rolesSocketPath = path.join(baseDir, "roles.sock");
  const stateFilePath = path.join(baseDir, "state.json");

  const workDir = path.join(repoRoot, "test", "fileflow", runId);
  const inputPath = path.join(workDir, "input.txt");
  const step1Path = path.join(workDir, "step1.txt");
  const finalPath = path.join(workDir, "final.txt");
  const auditPath = path.join(workDir, "audit.txt");
  const recordPath = path.join(workDir, "record.md");

  const taskInstructionA = [
    "FILEFLOW_TASK=A",
    `READ ${inputPath}`,
    `WRITE ${step1Path} with prefix "step1: "`,
    `APPEND audit: claude:A read=... write=...`
  ].join("\n");

  const taskInstructionB = [
    "FILEFLOW_TASK=B",
    `READ ${step1Path}`,
    `WRITE ${finalPath} with prefix "final: "`,
    `APPEND audit: codex:B read=... write=...`
  ].join("\n");

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

  const hub = await startAutoFileflowFakeHub(hubSocketPath, {
    idleInstances,
    inputPath,
    step1Path,
    finalPath,
    auditPath
  });

  const client = new A2AClient({
    hubSocketPath,
    rolesSocketPath,
    connectTimeoutMs: 500,
    responseTimeoutMs: 2_000,
    retryBaseDelayMs: 25,
    maxRetryDelayMs: 100,
    log: createLogger()
  });

  const stateStore = new StateStore(stateFilePath);
  const registry = new RoleRegistry();
  registry.register("dispatcher", (threadId, config) => new DispatcherRole(threadId, config, { stateStore, rolesSocketPath }));

  const runner = new RoleRunner({
    sendToHub: (message) => client.send(message),
    listInstances: () => client.listInstances(),
    log: createLogger()
  });

  const roleHandlers = createRoleHandlers({
    runner,
    registry,
    stateStore,
    log: createLogger()
  });

  const promptStore = new PromptStore({
    stateStore,
    resolveRole: roleHandlers.resolveRole
  });
  const promptHandlers = createPromptHandlers(promptStore);

  const resultServer = new A2AServer((result) => runner.dispatch(result), {
    socketPath: rolesSocketPath,
    log: createLogger()
  });

  await resultServer.listen();
  await client.start();

  return {
    hub,
    runId,
    inputPath,
    step1Path,
    finalPath,
    auditPath,
    recordPath,
    taskInstructionA,
    taskInstructionB,
    requestJson: (method, pathname, body) => invokeJson(roleHandlers, promptHandlers, method, pathname, body),
    readState: () => readStateFile(stateFilePath),
    async close() {
      await Promise.allSettled([
        client.stop(),
        resultServer.close(),
        hub.close()
      ]);

      // Keep workDir for inspection (record + output files).
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  };
}

async function startAutoFileflowFakeHub(
  socketPath: string,
  options: {
    idleInstances: AgentInstance[];
    inputPath: string;
    step1Path: string;
    finalPath: string;
    auditPath: string;
  }
): Promise<FakeHub> {
  const messages: HubMessage[] = [];

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let raw = "";

    socket.on("data", (chunk) => {
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
    close: async () => {
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

    if (message.intent === "list") {
      socket.end(JSON.stringify({
        trace_id: message.trace_id,
        thread_id: message.thread_id,
        source: "codex",
        status: "success",
        content: JSON.stringify(options.idleInstances),
        attachments: [],
        timestamp: new Date().toISOString()
      }));
      return;
    }

    if (message.intent === "run") {
      if (message.reply_channel.channel !== "socket" || !message.reply_channel.socket_path) {
        socket.end();
        return;
      }

      const agent = inferAgentFromTarget(message.target);
      try {
        await performFileflowForAgent(agent, {
          inputPath: options.inputPath,
          step1Path: options.step1Path,
          finalPath: options.finalPath,
          auditPath: options.auditPath
        });

        const result: HubResult = {
          trace_id: message.trace_id,
          thread_id: message.thread_id,
          source: agent,
          status: "success",
          content: agent === "claude" ? "A complete" : "B complete",
          attachments: [],
          timestamp: new Date().toISOString()
        };

        await sendSocketPayload(message.reply_channel.socket_path, result);
      } catch (error) {
        const result: HubResult = {
          trace_id: message.trace_id,
          thread_id: message.thread_id,
          source: agent,
          status: "error",
          content: error instanceof Error ? error.message : String(error),
          attachments: [],
          timestamp: new Date().toISOString()
        };

        await sendSocketPayload(message.reply_channel.socket_path, result);
      }
    }

    socket.end();
  }

  async function performFileflowForAgent(
    agent: "claude" | "codex",
    paths: { inputPath: string; step1Path: string; finalPath: string; auditPath: string }
  ): Promise<void> {
    if (agent === "claude") {
      const input = await fs.readFile(paths.inputPath, "utf8");
      await fs.mkdir(path.dirname(paths.step1Path), { recursive: true });
      const step1 = `step1: ${input}`;
      await fs.writeFile(paths.step1Path, step1, "utf8");
      await fs.appendFile(paths.auditPath, `claude:A read=${paths.inputPath} write=${paths.step1Path}\n`, "utf8");
      return;
    }

    const step1 = await fs.readFile(paths.step1Path, "utf8");
    await fs.mkdir(path.dirname(paths.finalPath), { recursive: true });
    const final = `final: ${step1}`;
    await fs.writeFile(paths.finalPath, final, "utf8");
    await fs.appendFile(paths.auditPath, `codex:B read=${paths.step1Path} write=${paths.finalPath}\n`, "utf8");
  }

  function inferAgentFromTarget(target: string): "claude" | "codex" {
    return target.includes("claude") ? "claude" : "codex";
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

function cryptoLikeId(): string {
  // Deterministic enough for local test isolation.
  return Math.random().toString(16).slice(2, 10);
}
