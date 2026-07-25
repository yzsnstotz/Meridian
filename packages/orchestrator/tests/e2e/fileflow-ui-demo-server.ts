import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { AgentDispatcherRole } from "../../src/roles/definitions/agent-dispatcher";
import { PromptStore } from "../../src/roles/prompt-store";
import { RoleRegistry } from "../../src/roles/role-registry";
import { RoleRunner } from "../../src/roles/role-runner";
import { createPromptHandlers } from "../../src/server/prompt-handlers";
import { createRoleHandlers } from "../../src/server/role-handlers";
import { HttpServer } from "../../src/server/http-server";
import { StateStore } from "../../src/state-store";
import updateStatusTool from "../../src/tool-gateway/tools/update-status";
import type { ReplyChannel } from "../../src/types";

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "../..");
  const fixtureDir = path.join(repoRoot, "test", "gui-demo");
  const baseDir = await fs.mkdtemp("/tmp/meridian-roles-gui-demo-");
  const stateFilePath = path.join(baseDir, "state.json");
  const httpPort = await getFreePort();
  const httpBaseUrl = `http://127.0.0.1:${httpPort}`;
  const runId = `gui-demo-${randomUUID().slice(0, 8)}`;

  const dispatchPlanPath = path.join(fixtureDir, "dispatch_plan.md");
  const commandFilePath = path.join(fixtureDir, "agent_dispatch_command.md");
  const inputPath = path.join(fixtureDir, "input.txt");
  const step1Path = path.join(fixtureDir, "step1.txt");
  const finalPath = path.join(fixtureDir, "final.txt");
  const auditPath = path.join(fixtureDir, "audit.txt");
  const recordPath = path.join(fixtureDir, "record.md");
  const sidecarPath = path.join(fixtureDir, "dispatch_threads.json");

  const userReplyChannel: ReplyChannel = {
    channel: "web",
    chat_id: "web:gui-demo"
  };
  const sessionLogLines: string[] = [];
  const log = createLogger();
  const stateStore = new StateStore(stateFilePath);
  const registry = new RoleRegistry();
  const runner = new RoleRunner({
    sendToHub: async () => undefined,
    listInstances: () => [],
    log
  });

  await resetDemoFixture({
    dispatchPlanPath,
    inputPath,
    step1Path,
    finalPath,
    auditPath,
    recordPath,
    sidecarPath
  });

  registry.register(
    "agent-dispatcher",
    (threadId, config) => new AgentDispatcherRole(threadId, config, {
      stateStore,
      launchDispatcher: async ({ systemPrompt }) => {
        const dispatcherThreadId = `dispatcher-${runId}`;
        sessionLogLines.push(`[dispatcher] started ${dispatcherThreadId}`);
        sessionLogLines.push(`[dispatcher] prompt first line: ${firstLine(systemPrompt)}`);
        void runDemoDispatcher({
          dispatchPlanPath,
          commandFilePath,
          inputPath,
          step1Path,
          finalPath,
          auditPath,
          sessionLogLines
        });

        return {
          ok: true,
          threadId: dispatcherThreadId
        };
      },
      killThread: async () => undefined,
      signalDispatcher: async () => undefined
    })
  );

  const roleHandlers = createRoleHandlers({
    runner,
    registry,
    stateStore,
    listReplyChannels: async () => [userReplyChannel],
    getThreadDetail: async () => sessionLogLines.join("\n"),
    attachToThread: async (threadId) => {
      sessionLogLines.push(`[attach] attached role-detail session to ${threadId}`);
    },
    log
  });
  const promptStore = new PromptStore({
    stateStore,
    resolveRole: roleHandlers.resolveRole
  });
  const promptHandlers = createPromptHandlers(promptStore);
  const httpServer = new HttpServer({
    port: httpPort,
    host: "127.0.0.1",
    roleHandlers,
    promptHandlers,
    log
  });

  await httpServer.listen();

  console.log(`[gui-demo] GUI: ${httpBaseUrl}`);
  console.log(`[gui-demo] fixtureDir: ${fixtureDir}`);

  const started = await startDemo(httpBaseUrl, {
    dispatchPlanPath,
    commandFilePath,
    userReplyChannel
  });
  console.log(`[gui-demo] dispatcherId: ${started.dispatcher_id}`);
  console.log(`[gui-demo] dispatcherThreadId: ${started.dispatcher_thread_id}`);

  await waitForDemoOutputs({ finalPath, sidecarPath, dispatchPlanPath });

  const detail = await fetchJson<{
    dispatcher_thread_id: string;
    session_log?: string[];
    dispatch_plan?: { rows?: Array<{ worker: string; status: string }> };
  }>(`${httpBaseUrl}/api/role/${encodeURIComponent(started.dispatcher_id)}`);

  const [step1, final, auditRaw, sidecarRaw, planRaw] = await Promise.all([
    fs.readFile(step1Path, "utf8"),
    fs.readFile(finalPath, "utf8"),
    fs.readFile(auditPath, "utf8"),
    fs.readFile(sidecarPath, "utf8"),
    fs.readFile(dispatchPlanPath, "utf8")
  ]);

  await fs.writeFile(recordPath, [
    "# Agent Dispatcher GUI Demo Record",
    "",
    `Run id: ${runId}`,
    `Dispatcher id: ${started.dispatcher_id}`,
    `Dispatcher thread: ${started.dispatcher_thread_id}`,
    "",
    "## Attach-aware detail check",
    "",
    `- dispatcher_thread_id from detail: ${detail.dispatcher_thread_id}`,
    `- session_log lines: ${detail.session_log?.length ?? 0}`,
    "",
    "## step1.txt",
    "```",
    step1.trimEnd(),
    "```",
    "",
    "## final.txt",
    "```",
    final.trimEnd(),
    "```",
    "",
    "## audit.txt",
    "```",
    auditRaw.trimEnd(),
    "```",
    "",
    "## dispatch_threads.json",
    "```json",
    sidecarRaw.trimEnd(),
    "```",
    "",
    "## dispatch_plan.md",
    "```md",
    planRaw.trimEnd(),
    "```"
  ].join("\n"), "utf8");

  console.log(`[gui-demo] DONE record: ${recordPath}`);

  await sleep(45_000);
  await httpServer.close();
  await fs.rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
}

async function runDemoDispatcher(args: {
  dispatchPlanPath: string;
  commandFilePath: string;
  inputPath: string;
  step1Path: string;
  finalPath: string;
  auditPath: string;
  sessionLogLines: string[];
}): Promise<void> {
  const commandText = await fs.readFile(args.commandFilePath, "utf8");
  args.sessionLogLines.push(`[dispatcher] command first line: ${firstLine(commandText)}`);

  await runWorker({
    worker: "A-01",
    dispatchPlanPath: args.dispatchPlanPath,
    sessionLogLines: args.sessionLogLines,
    onRun: async () => {
      const input = await fs.readFile(args.inputPath, "utf8");
      await fs.writeFile(args.step1Path, `step1: ${input}`, "utf8");
      await fs.appendFile(args.auditPath, `A-01 read=${args.inputPath} write=${args.step1Path}\n`, "utf8");
    }
  });

  await runWorker({
    worker: "B-01",
    dispatchPlanPath: args.dispatchPlanPath,
    sessionLogLines: args.sessionLogLines,
    onRun: async () => {
      const step1 = await fs.readFile(args.step1Path, "utf8");
      await fs.writeFile(args.finalPath, `final: ${step1}`, "utf8");
      await fs.appendFile(args.auditPath, `B-01 read=${args.step1Path} write=${args.finalPath}\n`, "utf8");
    }
  });

  args.sessionLogLines.push("[dispatcher] all non-human workers are terminal");
}

async function runWorker(args: {
  worker: string;
  dispatchPlanPath: string;
  sessionLogLines: string[];
  onRun: () => Promise<void>;
}): Promise<void> {
  const workerThreadId = `${args.worker.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const startResult = await updateStatusTool.execute({
    plan: args.dispatchPlanPath,
    worker: args.worker,
    status: "in_progress",
    thread_id: workerThreadId
  });
  if (!startResult.ok) {
    throw new Error(startResult.error ?? `Failed to start ${args.worker}`);
  }

  args.sessionLogLines.push(`[worker] ${args.worker} -> ${workerThreadId}`);
  await sleep(200);

  try {
    await args.onRun();
    const doneResult = await updateStatusTool.execute({
      plan: args.dispatchPlanPath,
      worker: args.worker,
      status: "done"
    });
    if (!doneResult.ok) {
      throw new Error(doneResult.error ?? `Failed to complete ${args.worker}`);
    }
    args.sessionLogLines.push(`[worker] ${args.worker} completed`);
  } catch (error) {
    await updateStatusTool.execute({
      plan: args.dispatchPlanPath,
      worker: args.worker,
      status: "failed"
    });
    args.sessionLogLines.push(`[worker] ${args.worker} failed: ${asError(error).message}`);
    throw error;
  }
}

async function startDemo(
  baseUrl: string,
  args: {
    dispatchPlanPath: string;
    commandFilePath: string;
    userReplyChannel: ReplyChannel;
  }
): Promise<{ dispatcher_id: string; dispatcher_thread_id: string }> {
  const response = await fetch(`${baseUrl}/api/agent-dispatcher/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      thread_id: "agent-dispatcher-gui-demo",
      dispatch_plan_path: args.dispatchPlanPath,
      command_file_path: args.commandFilePath,
      user_reply_channels: [args.userReplyChannel],
      agent_type: "codex",
      mode: "bridge",
      kill_policy: "always"
    })
  });

  if (!response.ok) {
    throw new Error(`POST /api/agent-dispatcher/start failed: HTTP ${response.status} ${await response.text()}`);
  }

  return await response.json() as { dispatcher_id: string; dispatcher_thread_id: string };
}

async function waitForDemoOutputs(args: {
  finalPath: string;
  sidecarPath: string;
  dispatchPlanPath: string;
}): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    try {
      const [finalRaw, sidecarRaw, planRaw] = await Promise.all([
        fs.readFile(args.finalPath, "utf8"),
        fs.readFile(args.sidecarPath, "utf8"),
        fs.readFile(args.dispatchPlanPath, "utf8")
      ]);

      if (
        finalRaw.trim().length > 0
        && sidecarRaw.includes('"status": "completed"')
        && planRaw.includes("| ✅ | 1 | A-01 |")
        && planRaw.includes("| ✅ | 2 | B-01 |")
      ) {
        return;
      }
    } catch {
      // Continue polling while the dispatcher flow writes its artifacts.
    }

    await sleep(200);
  }

  throw new Error("Timed out waiting for the GUI demo to produce terminal outputs");
}

async function resetDemoFixture(args: {
  dispatchPlanPath: string;
  inputPath: string;
  step1Path: string;
  finalPath: string;
  auditPath: string;
  recordPath: string;
  sidecarPath: string;
}): Promise<void> {
  await fs.mkdir(path.dirname(args.dispatchPlanPath), { recursive: true });

  const dispatchPlan = await fs.readFile(args.dispatchPlanPath, "utf8");
  const resetPlan = dispatchPlan
    .split(/\r?\n/)
    .map((line) => {
      if (line.includes("| A-01 |") || line.includes("| B-01 |")) {
        return line.replace(/\|\s*[⬜🔄✅⛔]\s*\|/, "| ⬜ |");
      }
      return line;
    })
    .join("\n");

  await fs.writeFile(args.dispatchPlanPath, resetPlan, "utf8");
  await fs.writeFile(args.inputPath, "hello-from-gui-demo\n", "utf8");
  await fs.writeFile(args.auditPath, "", "utf8");
  await fs.rm(args.step1Path, { force: true }).catch(() => undefined);
  await fs.rm(args.finalPath, { force: true }).catch(() => undefined);
  await fs.rm(args.recordPath, { force: true }).catch(() => undefined);
  await fs.rm(args.sidecarPath, { force: true }).catch(() => undefined);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  }

  return await response.json() as T;
}

function firstLine(content: string): string {
  return content.split(/\r?\n/, 1)[0] ?? "";
}

function createLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected an ephemeral port"));
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

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
