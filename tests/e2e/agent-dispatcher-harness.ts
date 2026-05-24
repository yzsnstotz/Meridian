import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { LifecycleStore } from "../../src/roles/agent-dispatcher/lifecycle-store";
import type { LaunchConfig, LaunchResult } from "../../src/roles/agent-dispatcher/launcher";
import type { LaunchDispatchWorkerConfig, LaunchDispatchWorkerResult } from "../../src/roles/agent-dispatcher/worker-launcher";
import { AgentDispatcherRole } from "../../src/roles/definitions/agent-dispatcher";
import { PromptStore } from "../../src/roles/prompt-store";
import { RoleRegistry } from "../../src/roles/role-registry";
import { RoleRunner } from "../../src/roles/role-runner";
import { createPromptHandlers, type PromptHandlers } from "../../src/server/prompt-handlers";
import { createRoleHandlers, type RoleHandlers } from "../../src/server/role-handlers";
import { StateStore } from "../../src/state-store";
import { AppStateSchema, type AppState, type DispatchThreadStateV2, type HubMessage, type HubResult } from "../../src/types";

export interface DispatchPlanRowInput {
  status?: string;
  batch?: string;
  worker: string;
  task?: string;
  model?: string;
  dependsOn?: string;
  notes?: string;
}

export interface AgentDispatcherHarness {
  baseDir: string;
  commandFilePath: string;
  dispatchPlanPath: string;
  docsRoot: string;
  launchConfigs: LaunchConfig[];
  workerLaunches: LaunchDispatchWorkerConfig[];
  requestJson<T>(method: string, url: string, body?: unknown): Promise<T>;
  startDispatcher(body?: Record<string, unknown>): Promise<{
    ok: true;
    dispatcher_id: string;
    dispatcher_thread_id: string;
  }>;
  readLifecycle(): DispatchThreadStateV2;
  readState(): Promise<AppState>;
  completeWorker(workerId: string, content?: string): void;
  writeDispatchPlan(rows: DispatchPlanRowInput[]): Promise<void>;
  close(): Promise<void>;
}

export interface AgentDispatcherHarnessOptions {
  name?: string;
  planRows?: DispatchPlanRowInput[];
  attachToThread?: (threadId: string) => Promise<void>;
  getThreadDetail?: (threadId: string) => Promise<string>;
  sendHubRequest?: (message: HubMessage) => Promise<HubResult>;
}

export async function startAgentDispatcherHarness(
  options: AgentDispatcherHarnessOptions = {}
): Promise<AgentDispatcherHarness> {
  const name = options.name ?? "agent-dispatcher-e2e";
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const docsRoot = path.join(baseDir, "docs");
  const dispatchRepoRoot = path.join(baseDir, "repo");
  const dispatchPlanPath = path.join(docsRoot, "dispatch_plan.md");
  const commandFilePath = path.join(docsRoot, "agent_dispatch_command.md");
  const stateStore = new StateStore(path.join(baseDir, "state.json"));
  const launchConfigs: LaunchConfig[] = [];
  const workerLaunches: LaunchDispatchWorkerConfig[] = [];
  const log = createLogger();

  await fs.mkdir(docsRoot, { recursive: true });
  await fs.mkdir(dispatchRepoRoot, { recursive: true });
  await fs.writeFile(commandFilePath, "# Agent Dispatch Command\n", "utf8");
  await writeDispatchPlanFile(dispatchPlanPath, options.planRows ?? [
    {
      worker: "W-01",
      task: "Implement first worker"
    }
  ]);

  const registry = new RoleRegistry();
  const createAgentDispatcherRole = (threadId: string, config: unknown) => new AgentDispatcherRole(threadId, config, {
    stateStore,
    launchDispatcher: async (launchConfig): Promise<LaunchResult> => {
      launchConfigs.push(launchConfig);
      return {
        ok: true,
        threadId: `dispatcher-thread-${launchConfigs.length}`
      };
    }
  });
  registry.register("agent-dispatcher", createAgentDispatcherRole);
  registry.register("dispatcher", createAgentDispatcherRole);

  const runner = new RoleRunner({
    sendToHub: async () => undefined,
    listInstances: () => [],
    log
  });
  const roleHandlers = createRoleHandlers({
    runner,
    registry,
    stateStore,
    attachToThread: options.attachToThread,
    getThreadDetail: options.getThreadDetail,
    sendHubRequest: options.sendHubRequest,
    launchDispatchWorker: async (workerConfig): Promise<LaunchDispatchWorkerResult> => {
      workerLaunches.push(workerConfig);
      const threadId = `worker-thread-${workerLaunches.length}`;
      new LifecycleStore(resolveDispatchThreadsPath(workerConfig.dispatchPlanPath), {
        dispatchPlanPath: workerConfig.dispatchPlanPath,
        log
      }).recordWorkerStart(workerConfig.workerId, threadId, randomUUID(), [], `Run ${workerConfig.workerId}`);
      return {
        ok: true,
        threadId
      };
    },
    log
  });
  const promptStore = new PromptStore({
    stateStore,
    resolveRole: roleHandlers.resolveRole
  });
  const promptHandlers = createPromptHandlers(promptStore);

  return {
    baseDir,
    commandFilePath,
    dispatchPlanPath,
    docsRoot,
    launchConfigs,
    workerLaunches,
    requestJson: (method, url, body) => invokeJson(roleHandlers, promptHandlers, method, url, body),
    startDispatcher(body = {}) {
      return invokeJson(roleHandlers, promptHandlers, "POST", "/api/agent-dispatcher/start", {
        thread_id: "agent-dispatcher-e2e",
        dispatch_plan_path: dispatchPlanPath,
        command_file_path: commandFilePath,
        dispatch_repo_root: dispatchRepoRoot,
        docs_root: docsRoot,
        user_reply_channel: {
          channel: "web",
          chat_id: "web:e2e"
        },
        agent_type: "codex",
        mode: "bridge",
        kill_policy: "always",
        ...body
      });
    },
    readLifecycle() {
      return new LifecycleStore(resolveDispatchThreadsPath(dispatchPlanPath), {
        dispatchPlanPath,
        log
      }).load();
    },
    async readState() {
      const raw = await fs.readFile(path.join(baseDir, "state.json"), "utf8");
      return AppStateSchema.parse(JSON.parse(raw));
    },
    completeWorker(workerId, content = `${workerId} complete`) {
      const lifecycleStore = new LifecycleStore(resolveDispatchThreadsPath(dispatchPlanPath), {
        dispatchPlanPath,
        log
      });
      const worker = lifecycleStore.load().workers[workerId];
      if (!worker) {
        throw new Error(`Worker was not launched: ${workerId}`);
      }

      lifecycleStore.recordWorkerResult(workerId, {
        trace_id: worker.trace_id ?? randomUUID(),
        thread_id: worker.thread_id,
        source: "codex",
        status: "success",
        content,
        attachments: [],
        timestamp: new Date().toISOString()
      } satisfies HubResult);
    },
    writeDispatchPlan(rows) {
      return writeDispatchPlanFile(dispatchPlanPath, rows);
    },
    async close() {
      await Promise.allSettled([
        runner.deactivate("agent-dispatcher-e2e"),
        fs.rm(baseDir, { recursive: true, force: true })
      ]);
    }
  };
}

export async function invokeJson<T>(
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

export function formatDispatchPlan(rows: DispatchPlanRowInput[]): string {
  const formattedRows = rows.map((row) => [
    row.status ?? "⬜",
    row.batch ?? "1",
    row.worker,
    row.task ?? row.worker,
    row.model ?? "CODEX",
    row.dependsOn ?? "—",
    row.notes ?? "—"
  ]);

  return [
    "# E2E Dispatch Plan",
    "",
    "## Model Assignment Legend",
    "",
    "| Code | Provider | Model ID |",
    "| --- | --- | --- |",
    "| CODEX | codex | gpt-5.4 medium |",
    "| CODEX-HIGH | codex | gpt-5.5 high |",
    "",
    "## Master Dispatch Table",
    "",
    "| Status | Batch | Worker | Task | Model | Depends On | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...formattedRows.map((row) => `| ${row.join(" | ")} |`),
    ""
  ].join("\n");
}

async function writeDispatchPlanFile(dispatchPlanPath: string, rows: DispatchPlanRowInput[]): Promise<void> {
  await fs.writeFile(dispatchPlanPath, formatDispatchPlan(rows), "utf8");
}

function resolveDispatchThreadsPath(dispatchPlanPath: string): string {
  return path.join(path.dirname(dispatchPlanPath), "dispatch_threads.json");
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

function createLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
