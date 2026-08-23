import * as fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { AgentInstance, AppState, HubMessage, HubResult, ReplyChannel } from "../../src/types";

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "../..");
  const runId = `fileflow-ui2-${randomUUID().slice(0, 8)}`;

  const baseDir = await fs.mkdtemp("/tmp/meridian-roles-fileflow-ui2-");
  const hubSocketPath = path.join(baseDir, "hub.sock");

  // Critical: DispatcherRole uses ROLES_SOCKET_PATH from src/config.ts at import time.
  // We must set it before dynamically importing roles/server modules.
  const rolesSocketPath = path.join(baseDir, "roles.sock");
  process.env.ROLES_SOCKET_PATH = rolesSocketPath;

  const stateFilePath = path.join(baseDir, "state.json");

  const httpPort = await getFreePort();
  const httpBaseUrl = `http://127.0.0.1:${httpPort}`;

  const workDir = path.join(repoRoot, "test", "fileflow-ui-demo2", runId);
  const inputPath = path.join(workDir, "input.txt");
  const step1Path = path.join(workDir, "step1.txt");
  const finalPath = path.join(workDir, "final.txt");
  const auditPath = path.join(workDir, "audit.txt");
  const recordPath = path.join(workDir, "record.md");

  const dispatcherThreadId = `dispatcher-fileflow-ui2-${runId}`;
  const userReplyChannel: ReplyChannel = { channel: "telegram", chat_id: "telegram:fileflow-ui2" };

  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(inputPath, "input: Meridian-roles\n", "utf8");
  await fs.writeFile(auditPath, "", "utf8");

  const {
    A2AClient
  } = await import("../../src/a2a/client");
  const { A2AServer } = await import("../../src/a2a/server");
  const { DispatcherRole } = await import("../../src/roles/definitions");
  const { RoleRegistry } = await import("../../src/roles/role-registry");
  const { RoleRunner } = await import("../../src/roles/role-runner");
  const { PromptStore } = await import("../../src/roles/prompt-store");
  const { createPromptHandlers } = await import("../../src/server/prompt-handlers");
  const { createRoleHandlers } = await import("../../src/server/role-handlers");
  const { HttpServer } = await import("../../src/server/http-server");
  const { StateStore } = await import("../../src/state-store");
  const { AppStateSchema, HubMessageSchema } = await import("../../src/types");

  const idleInstances: AgentInstance[] = [
    {
      thread_id: "claude_01",
      agent_type: "claude",
      model_id: "opus",
      mode: "bridge",
      socket_path: "/tmp/claude.sock",
      working_dir: "/tmp",
      pid: 101,
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
      status: "idle",
      created_at: "2026-03-19T00:00:00.000Z",
      restart_safe: true,
      auto_approve: false
    }
  ];

  const hub = await startFakeHub(hubSocketPath, {
    idleInstances,
    inputPath,
    step1Path,
    finalPath,
    auditPath,
    HubMessageSchema
  });
  void hub;

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
  registry.register("dispatcher", (threadId, config) => new DispatcherRole(threadId, config, { stateStore }));

  const runner = new RoleRunner({
    sendToHub: (message) => client.send(message),
    listInstances: () => client.listInstances(),
    log: createLogger()
  });

  const roleHandlers = createRoleHandlers({
    runner,
    registry,
    stateStore,
    listReplyChannels: async () => [userReplyChannel],
    getThreadDetail: async (threadId) => `Thread ${threadId}`,
    log: createLogger()
  });

  const promptStore = new PromptStore({ stateStore, resolveRole: roleHandlers.resolveRole });
  const promptHandlers = createPromptHandlers(promptStore);

  const httpServer = new HttpServer({
    port: httpPort,
    host: "127.0.0.1",
    roleHandlers,
    promptHandlers,
    log: createLogger()
  });

  const resultServer = new A2AServer((result) => runner.dispatch(result), {
    socketPath: rolesSocketPath,
    log: createLogger()
  });

  await httpServer.listen();
  await resultServer.listen();
  await client.start();

  console.log(`[fileflow-ui-demo2] GUI: ${httpBaseUrl}`);
  console.log(`[fileflow-ui-demo2] dispatcherThreadId: ${dispatcherThreadId}`);
  console.log(`[fileflow-ui-demo2] output workDir: ${workDir}`);

  await publishDispatcherViaHttp(httpBaseUrl, dispatcherThreadId, userReplyChannel, {
    inputPath,
    step1Path,
    finalPath
  });

  await waitUntilCompleted(httpBaseUrl, dispatcherThreadId, { timeoutMs: 20_000 });

  const appState: AppState = await readState(stateFilePath, AppStateSchema);
  if (!appState.roles.some((r) => r.threadId === dispatcherThreadId && r.status === "completed")) {
    throw new Error("Dispatcher role did not reach completed state in persisted AppState");
  }

  const [step1, final, auditRaw] = await Promise.all([
    fs.readFile(step1Path, "utf8"),
    fs.readFile(finalPath, "utf8"),
    fs.readFile(auditPath, "utf8")
  ]);

  const recordMarkdown = buildRecordMarkdown({
    runId,
    dispatcherThreadId,
    inputPath,
    step1Path,
    finalPath,
    auditRaw,
    step1,
    final
  });

  await fs.writeFile(recordPath, recordMarkdown, "utf8");
  console.log(`[fileflow-ui-demo2] DONE record: ${recordPath}`);

  // Keep server alive for browser inspection.
  await sleep(45_000);
}

async function publishDispatcherViaHttp(
  baseUrl: string,
  threadId: string,
  userReplyChannel: ReplyChannel,
  paths: { inputPath: string; step1Path: string; finalPath: string }
): Promise<void> {
  const payload = {
    thread_id: threadId,
    user_reply_channel: userReplyChannel,
    tasks: [
      {
        task_id: "A",
        instruction: `FILEFLOW_TASK=A READ ${paths.inputPath} WRITE ${paths.step1Path} (prefix step1:)`,
        depends_on: [],
        target_thread_id: "claude_01"
      },
      {
        task_id: "B",
        instruction: `FILEFLOW_TASK=B READ ${paths.step1Path} WRITE ${paths.finalPath} (prefix final:)`,
        depends_on: ["A"],
        target_agent_type: "codex"
      }
    ]
  };

  const response = await fetch(`${baseUrl}/api/role`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST /api/role failed: HTTP ${response.status} body=${text}`);
  }
}

async function waitUntilCompleted(
  baseUrl: string,
  threadId: string,
  options: { timeoutMs: number }
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/role/${encodeURIComponent(threadId)}`);
    const text = await response.text();
    if (response.ok) {
      const detail = text ? JSON.parse(text) : null;
      if (detail?.status === "completed") {
        return;
      }
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for dispatcher ${threadId} to become completed`);
}

async function readState(stateFilePath: string, AppStateSchema: { parse: (v: unknown) => AppState }): Promise<AppState> {
  const raw = await fs.readFile(stateFilePath, "utf8");
  return AppStateSchema.parse(JSON.parse(raw));
}

function buildRecordMarkdown(args: {
  runId: string;
  dispatcherThreadId: string;
  inputPath: string;
  step1Path: string;
  finalPath: string;
  auditRaw: string;
  step1: string;
  final: string;
}): string {
  return [
    "# Dispatcher Fileflow UI Demo2 Record",
    "",
    `Run id: ${args.runId}`,
    `Dispatcher thread: ${args.dispatcherThreadId}`,
    "",
    "## Outputs",
    "",
    `- step1Path: ${args.step1Path}`,
    "```",
    args.step1.trimEnd(),
    "```",
    "",
    `- finalPath: ${args.finalPath}`,
    "```",
    args.final.trimEnd(),
    "```",
    "",
    "## Agent audit (read/write trace)",
    "```",
    args.auditRaw.trimEnd(),
    "```"
  ].join("\n");
}

function createLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}

async function startFakeHub(
  socketPath: string,
  options: {
    idleInstances: AgentInstance[];
    inputPath: string;
    step1Path: string;
    finalPath: string;
    auditPath: string;
    HubMessageSchema: { parse: (v: unknown) => HubMessage };
  }
): Promise<{ close(): Promise<void> }> {
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
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await fs.unlink(socketPath).catch(() => undefined);
    }
  };

  async function handleMessage(socket: net.Socket, raw: string): Promise<void> {
    const message = options.HubMessageSchema.parse(JSON.parse(raw));

    if (message.intent === "register_service") {
      socket.end(
        JSON.stringify({
          trace_id: message.trace_id,
          thread_id: message.thread_id,
          source: "codex",
          status: "success",
          content: "registered",
          attachments: [],
          timestamp: new Date().toISOString()
        })
      );
      return;
    }

    if (message.intent === "list") {
      socket.end(
        JSON.stringify({
          trace_id: message.trace_id,
          thread_id: message.thread_id,
          source: "codex",
          status: "success",
          content: JSON.stringify(options.idleInstances),
          attachments: [],
          timestamp: new Date().toISOString()
        })
      );
      return;
    }

    if (message.intent === "run") {
      if (message.reply_channel.channel !== "socket" || !message.reply_channel.socket_path) {
        socket.end();
        return;
      }

      const agent = inferAgentFromTarget(message.target);
      try {
        await performFileflowForAgent(agent, options);
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

    // For `reply` / other intents: end socket; UI state changes are driven by `run` results.
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
}

function inferAgentFromTarget(target: string): "claude" | "codex" {
  return target.includes("claude") ? "claude" : "codex";
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
      await sleep(25);
    }
  }
  throw lastError;
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected an ephemeral TCP port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
