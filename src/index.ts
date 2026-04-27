import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { GUI_PORT, RECONCILE_INTERVAL_MS } from "./config";
import { A2AClient } from "./a2a/client";
import { A2AServer } from "./a2a/server";
import { continueDispatchWorker } from "./roles/agent-dispatcher/continue-worker";
import { LifecycleStore } from "./roles/agent-dispatcher/lifecycle-store";
import { reconcile } from "./roles/agent-dispatcher/reconciler";
import { ReconciliationWatchdog } from "./roles/agent-dispatcher/watchdog";
import { FileRelayWatcher } from "./tool-gateway/file-relay";
import { AgentDispatcherRole } from "./roles/definitions/agent-dispatcher";
import { SchedulerRole } from "./roles/definitions/scheduler";
import { SchedulerStateStore } from "./roles/scheduler/scheduler-state-store";
import { PromptStore } from "./roles/prompt-store";
import { RoleRegistry } from "./roles/role-registry";
import { RoleRunner, type RehydrationContext } from "./roles/role-runner";
import { createPromptHandlers } from "./server/prompt-handlers";
import { HttpServer } from "./server/http-server";
import { createRoleHandlers } from "./server/role-handlers";
import { createSchedulerHandlers } from "./server/scheduler-handlers";
import {
  ACTIVE_ROLE_STATUS,
  PAUSED_ROLE_STATUS,
  NEEDS_REACTIVATION_ROLE_STATUS,
  StateStore,
  isReconcilableAgentDispatcherRoleStatus,
  isStartupRehydratableRoleStatus
} from "./state-store";
import {
  AgentDispatcherConfigSchema,
  SchedulerConfigSchema,
  type AgentDispatcherConfig,
  type AppState,
  type HubMessage,
  type HubResult,
  type RoleState,
  type SchedulerConfig
} from "./types";
import { parseDispatchPlanRows } from "./tool-gateway/tools/dispatch-status";

export * from "./types";
export * from "./config";

export interface MeridianRolesService {
  close(): Promise<void>;
}

const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";
const STARTUP_STATUS_PROBE_TIMEOUT_MS = 4_500;
const LIVE_THREAD_STATUSES = new Set(["running", "waiting", "queued", "starting", "in_progress", "idle", "stable"]);

export async function startMeridianRolesService(): Promise<MeridianRolesService> {
  const log = console;
  const stateStore = new StateStore();
  const client = new A2AClient({ log });
  const registry = new RoleRegistry();
  const runner = new RoleRunner({
    sendToHub: (message) => client.send(message),
    listInstances: () => client.listInstances(),
    log
  });
  const resultServer = new A2AServer((result) => runner.dispatch(result), { log });

  registry.register("dispatcher", (threadId, config) => new AgentDispatcherRole(threadId, config, { stateStore }));
  registry.register("agent-dispatcher", (threadId, config) => new AgentDispatcherRole(threadId, config, { stateStore }));
  registry.register("scheduler", (threadId, config) => new SchedulerRole(threadId, config, { stateStore }));

  const startupActivations = await buildStartupActivations(stateStore, client, log);
  await reconcileStartupDispatchers(startupActivations, client, log);

  await resultServer.listen();
  await activatePersistedRoles(startupActivations, registry, runner, log);

  const roleHandlers = createRoleHandlers({
    runner,
    registry,
    stateStore,
    listReplyChannels: () => client.listReplyChannels(),
    getThreadDetail: async (threadId) => (await client.getThreadDetail(threadId)).content,
    log
  });
  const promptStore = new PromptStore({
    stateStore,
    resolveRole: roleHandlers.resolveRole
  });
  const promptHandlers = createPromptHandlers(promptStore);
  const schedulerHandlers = createSchedulerHandlers({
    runner,
    registry,
    stateStore,
    log
  });
  const httpServer = new HttpServer({
    port: GUI_PORT,
    roleHandlers,
    promptHandlers,
    schedulerHandlers,
    log
  });
  const watchdog = new ReconciliationWatchdog({
    resolveActiveDispatchPlanPaths: () => resolveDispatchPlanPathsFromState(stateStore),
    hubClient: client,
    log,
    intervalMs: RECONCILE_INTERVAL_MS,
    isDispatcherPaused: async (dispatchPlanPath) => {
      const state = await loadAppState(stateStore);
      const roleState = state.roles.find((role) => {
        if (role.roleType !== "agent-dispatcher") {
          return false;
        }
        const config = parseAgentDispatcherConfig(role);
        return config?.dispatch_plan_path === dispatchPlanPath;
      });
      return roleState?.status === PAUSED_ROLE_STATUS;
    },
    onDispatcherStalled: async (info) => {
      const threadId = await resolveThreadIdForDispatchPlanPath(stateStore, info.dispatchPlanPath);
      if (!threadId) {
        log.warn("Watchdog stall: no persisted agent-dispatcher found for plan", {
          dispatchPlanPath: info.dispatchPlanPath
        });
        return;
      }

      const continuedWorkerId = await tryContinueDispatchWorker(
        stateStore,
        info.dispatchPlanPath,
        info.continueWorkerId,
        log
      );
      if (continuedWorkerId) {
        log.info("Watchdog stall: continued worker through service-owned recovery", {
          threadId,
          workerId: continuedWorkerId
        });
        return;
      }

      const existingRole = runner.getRole(threadId);
      if (existingRole) {
        log.info("Watchdog stall: relaunching active dispatcher hub session", { threadId });
        await runner.relaunchAgentDispatcherHub(threadId);
        return;
      }

      log.info("Watchdog stall: reactivating persisted dispatcher", { threadId });
      const state = await loadAppState(stateStore);
      const roleState = state.roles.find((role) => role.threadId === threadId);
      if (!roleState?.config) {
        return;
      }

      const role = registry.create("agent-dispatcher", threadId, roleState.config);
      await runner.activate(role, { needsReactivation: true });
    }
  });

  const fileRelay = new FileRelayWatcher();

  await httpServer.listen();
  void client.start().catch((error) => {
    if (error instanceof Error && error.message === "A2A client stopped before register_service completed") {
      return;
    }
    log.warn("A2A client background start failed", error);
  });
  watchdog.start();
  await fileRelay.start();

  return {
    async close(): Promise<void> {
      fileRelay.stop();
      watchdog.stop();
      await Promise.allSettled([httpServer.close(), resultServer.close(), client.stop()]);
    }
  };
}

interface StartupActivation {
  roleState: RoleState;
  rehydrationContext: RehydrationContext;
  dispatcherConfig: AgentDispatcherConfig | null;
}

interface StartupProbeResult {
  needsReactivation: boolean;
  dispatcherConfig: AgentDispatcherConfig | null;
  dispatcherThreadId: string | null;
  failureReason?: string;
}

type StatusRequestClient = {
  serviceId?: string;
  sendRequest?: (message: HubMessage) => Promise<HubResult>;
};

async function buildStartupActivations(
  stateStore: StateStore,
  client: A2AClient,
  log: typeof console
): Promise<StartupActivation[]> {
  const currentState = await loadAppState(stateStore);
  const startupRoles = currentState.roles
    .map((roleState, index) => ({ roleState, index }))
    .filter(({ roleState }) => isStartupRehydratableRoleStatus(roleState.status));

  if (startupRoles.length === 0) {
    return [];
  }

  const nextState: AppState = {
    roles: currentState.roles.map((roleState) => ({ ...roleState })),
    promptStore: currentState.promptStore
  };
  let stateChanged = false;
  const invalidStartupRoleIndexes = new Set<number>();
  const validStartupRoles = startupRoles.filter(({ roleState, index }) => {
    if (roleState.roleType !== "agent-dispatcher" || parseAgentDispatcherConfig(roleState)) {
      return true;
    }

    invalidStartupRoleIndexes.add(index);
    stateChanged = true;
    log.warn("Startup rehydration removed invalid persisted agent-dispatcher role", {
      roleId: roleState.threadId
    });
    return false;
  });
  const probes = await Promise.allSettled(
    validStartupRoles.map(({ roleState }) => probePersistedRole(roleState, client))
  );
  const activations: StartupActivation[] = [];

  validStartupRoles.forEach(({ roleState, index }, probeIndex) => {
    const probe = probes[probeIndex];
    const result = probe.status === "fulfilled"
      ? probe.value
      : {
          needsReactivation: true,
          dispatcherConfig: parseAgentDispatcherConfig(roleState),
          dispatcherThreadId: null,
          failureReason: asError(probe.reason).message
        };

    const nextRoleState = {
      ...nextState.roles[index]
    };

    if (result.dispatcherConfig) {
      const nextStatus = roleState.status === PAUSED_ROLE_STATUS
        ? PAUSED_ROLE_STATUS
        : result.needsReactivation
          ? NEEDS_REACTIVATION_ROLE_STATUS
          : ACTIVE_ROLE_STATUS;
      if (nextRoleState.status !== nextStatus) {
        nextRoleState.status = nextStatus;
        nextState.roles[index] = nextRoleState;
        stateChanged = true;
      }

      if (result.needsReactivation) {
        log.warn("Startup rehydration marked dispatcher for reactivation", {
          roleId: roleState.threadId,
          threadId: result.dispatcherThreadId,
          reason: result.failureReason ?? "dispatcher_thread_unavailable"
        });
      }
    }

    activations.push({
      roleState: nextRoleState,
      rehydrationContext: {
        needsReactivation: result.needsReactivation
      },
      dispatcherConfig: result.dispatcherConfig
    });
  });

  if (invalidStartupRoleIndexes.size > 0) {
    nextState.roles = nextState.roles.filter((_, index) => !invalidStartupRoleIndexes.has(index));
  }

  if (stateChanged) {
    await stateStore.save(nextState);
  }

  return activations;
}

async function reconcileStartupDispatchers(
  activations: StartupActivation[],
  client: A2AClient,
  log: typeof console
): Promise<void> {
  const dispatchPlanPaths = [...new Set(
    activations
      .map((activation) => activation.dispatcherConfig?.dispatch_plan_path)
      .filter((dispatchPlanPath): dispatchPlanPath is string => Boolean(dispatchPlanPath))
  )];

  await Promise.allSettled(
    dispatchPlanPaths.map(async (dispatchPlanPath) => {
      try {
        const lifecycleStore = new LifecycleStore(resolveDispatchThreadPath(dispatchPlanPath));
        const report = await reconcile(lifecycleStore, createStartupHubClient(client));
        log.info("Startup reconciliation completed", {
          dispatchPlanPath,
          changed: report.changed.length,
          unchanged: report.unchanged.length
        });
      } catch (error) {
        log.warn("Startup reconciliation failed", {
          dispatchPlanPath,
          error: asError(error).message
        });
      }
    })
  );
}

async function activatePersistedRoles(
  activations: StartupActivation[],
  registry: RoleRegistry,
  runner: RoleRunner,
  log: typeof console
): Promise<void> {
  for (const activation of activations) {
    try {
      const role = registry.create(
        activation.roleState.roleType,
        activation.roleState.threadId,
        activation.roleState.config ?? {}
      );
      await runner.activate(role, activation.rehydrationContext);
    } catch (error) {
      log.error("Startup role activation failed", {
        roleId: activation.roleState.threadId,
        roleType: activation.roleState.roleType,
        error: asError(error).message
      });
    }
  }
}

async function probePersistedRole(roleState: RoleState, client: A2AClient): Promise<StartupProbeResult> {
  const dispatcherConfig = parseAgentDispatcherConfig(roleState);
  if (!dispatcherConfig) {
    return {
      needsReactivation: false,
      dispatcherConfig: null,
      dispatcherThreadId: null
    };
  }

  const lifecycleStore = new LifecycleStore(resolveDispatchThreadPath(dispatcherConfig.dispatch_plan_path));
  const dispatcherThreadId = lifecycleStore.load().dispatcher.thread_id;
  if (!dispatcherThreadId) {
    return {
      needsReactivation: true,
      dispatcherConfig,
      dispatcherThreadId: null,
      failureReason: "missing_dispatcher_thread_id"
    };
  }

  const statusResult = await sendStartupStatusRequest(client, dispatcherThreadId);
  if (isLiveThreadStatus(statusResult)) {
    return {
      needsReactivation: false,
      dispatcherConfig,
      dispatcherThreadId
    };
  }

  return {
    needsReactivation: true,
    dispatcherConfig,
    dispatcherThreadId,
    failureReason: extractFailureReason(statusResult)
  };
}

function createStartupHubClient(client: A2AClient): A2AClient {
  const actorId = resolveStartupActorId(client);

  return {
    serviceId: actorId,
    sendRequest: async (message: HubMessage) => {
      try {
        return await withTimeout(sendRawHubRequest(client, message), STARTUP_STATUS_PROBE_TIMEOUT_MS);
      } catch (error) {
        return buildMissingThreadResult(message.thread_id, message.trace_id, asError(error).message);
      }
    }
  } as unknown as A2AClient;
}

async function sendStartupStatusRequest(client: A2AClient, threadId: string): Promise<HubResult> {
  const actorId = resolveStartupActorId(client);

  try {
    return await withTimeout(
      sendRawHubRequest(client, buildStatusMessage(threadId, actorId)),
      STARTUP_STATUS_PROBE_TIMEOUT_MS
    );
  } catch (error) {
    return buildMissingThreadResult(threadId, randomUUID(), asError(error).message);
  }
}

function resolveStartupActorId(client: A2AClient): string {
  const requestClient = client as unknown as StatusRequestClient;
  return typeof requestClient.serviceId === "string" && requestClient.serviceId.trim().length > 0
    ? requestClient.serviceId
    : "service:meridian-roles";
}

function sendRawHubRequest(client: A2AClient, message: HubMessage): Promise<HubResult> {
  const requestClient = client as unknown as StatusRequestClient;
  if (typeof requestClient.sendRequest !== "function") {
    return Promise.reject(new Error("A2AClient does not expose sendRequest"));
  }

  return requestClient.sendRequest(message);
}

function buildStatusMessage(threadId: string, actorId: string): HubMessage {
  return {
    trace_id: randomUUID(),
    thread_id: threadId,
    actor_id: actorId,
    intent: "status",
    target: threadId,
    priority: 5,
    mode: "bridge",
    reply_channel: {
      channel: "web",
      chat_id: actorId
    },
    payload: {
      content: "",
      attachments: []
    }
  };
}

function buildMissingThreadResult(threadId: string, traceId: string, reason: string): HubResult {
  return {
    trace_id: traceId,
    thread_id: threadId,
    source: "codex",
    status: "error",
    content: `unknown thread: ${reason}`,
    attachments: [],
    timestamp: new Date().toISOString()
  };
}

function isLiveThreadStatus(result: HubResult): boolean {
  if (result.status !== "success") {
    return false;
  }

  return extractStatusCandidates(result.content).some((candidate) => LIVE_THREAD_STATUSES.has(candidate));
}

function extractFailureReason(result: HubResult): string {
  if (result.status !== "success") {
    return result.content.trim() || "status_probe_failed";
  }

  const statusCandidates = extractStatusCandidates(result.content);
  return statusCandidates[0] ? `hub_status:${statusCandidates[0]}` : "unrecognized_status_payload";
}

function extractStatusCandidates(rawContent: string): string[] {
  const parsed = parseLeadingJsonObject(rawContent);
  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  const parsedRecord = parsed as Record<string, unknown>;
  const candidates: string[] = [];
  collectStatusCandidate(parsedRecord, "status", candidates);

  const instance = readRecordField(parsedRecord, "instance");
  if (instance) {
    collectStatusCandidate(instance, "status", candidates);
  }

  const agentStatus = readRecordField(parsedRecord, "agent_status");
  if (agentStatus) {
    collectStatusCandidate(agentStatus, "status", candidates);
  } else {
    collectStatusCandidate(parsedRecord, "agent_status", candidates);
  }

  return candidates;
}

function collectStatusCandidate(record: Record<string, unknown>, key: string, candidates: string[]): void {
  const candidate = record[key];
  if (typeof candidate !== "string") {
    return;
  }

  const normalized = candidate.trim().toLowerCase();
  if (normalized.length === 0) {
    return;
  }

  candidates.push(normalized);
}

function readRecordField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
}

function parseLeadingJsonObject(rawContent: string): unknown {
  const trimmed = rawContent.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }

      if (character === "\\") {
        escaping = true;
        continue;
      }

      if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character !== "}") {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return JSON.parse(trimmed.slice(0, index + 1));
    }
  }

  return null;
}

async function resolveThreadIdForDispatchPlanPath(
  stateStore: StateStore,
  dispatchPlanPath: string
): Promise<string | null> {
  const state = await loadAppState(stateStore);

  for (const role of state.roles) {
    if (role.roleType !== "agent-dispatcher" || !isReconcilableAgentDispatcherRoleStatus(role.status)) {
      continue;
    }

    const config = parseAgentDispatcherConfig(role);
    if (config?.dispatch_plan_path === dispatchPlanPath) {
      return role.threadId;
    }
  }

  return null;
}

async function tryContinueDispatchWorker(
  stateStore: StateStore,
  dispatchPlanPath: string,
  workerId: string | null,
  log: typeof console
): Promise<string | null> {
  if (!workerId) {
    return null;
  }

  const state = await loadAppState(stateStore);
  const roleState = state.roles.find((role) => {
    if (role.roleType !== "agent-dispatcher" || !isReconcilableAgentDispatcherRoleStatus(role.status)) {
      return false;
    }

    const config = parseAgentDispatcherConfig(role);
    return config?.dispatch_plan_path === dispatchPlanPath;
  }) ?? null;
  if (!roleState) {
    return null;
  }

  if (roleState.status === PAUSED_ROLE_STATUS) {
    return null;
  }
  const config = parseAgentDispatcherConfig(roleState);
  if (!config) {
    return null;
  }

  let markdown: string;
  try {
    markdown = await fs.readFile(dispatchPlanPath, "utf8");
  } catch (error) {
    log.warn("Watchdog failed to read dispatch plan for direct continue", {
      dispatchPlanPath,
      error: asError(error).message
    });
    return null;
  }

  const rows = parseDispatchPlanRows(markdown);
  const row = rows.find((candidate) => candidate.worker_id === workerId) ?? null;
  if (!row || isHumanModel(row.model)) {
    return null;
  }

  const continued = await continueDispatchWorker(config, rows.map((candidate) => ({
    status: candidate.status,
    worker: candidate.worker_id,
    model: candidate.model ?? ""
  })), workerId);
  if (!continued.ok) {
    log.warn("Watchdog direct continue failed", {
      dispatchPlanPath,
      workerId,
      error: continued.error ?? "unknown"
    });
    return null;
  }

  await persistAgentDispatcherRoleStatus(stateStore, roleState.threadId, ACTIVE_ROLE_STATUS, log);

  return workerId;
}

async function persistAgentDispatcherRoleStatus(
  stateStore: StateStore,
  threadId: string,
  status: string,
  log: typeof console
): Promise<void> {
  const state = await loadAppState(stateStore);
  const role = state.roles.find((entry) => entry.threadId === threadId);
  if (!role || role.roleType !== "agent-dispatcher" || role.status === status) {
    return;
  }

  role.status = status;
  try {
    await stateStore.save(state);
  } catch (error) {
    log.warn("Watchdog failed to persist agent-dispatcher role status", {
      threadId,
      status,
      error: asError(error).message
    });
  }
}

function isHumanModel(model: string | null | undefined): boolean {
  const normalized = typeof model === "string" ? model.trim().toUpperCase() : "";
  return normalized === "HUMAN" || normalized === "PM";
}

export async function resolveDispatchPlanPathsFromState(stateStore: StateStore): Promise<string[]> {
  const state = await loadAppState(stateStore);
  const paths: string[] = [];

  for (const role of state.roles) {
    if (role.roleType === "agent-dispatcher") {
      if (!isReconcilableAgentDispatcherRoleStatus(role.status)) {
        continue;
      }

      const config = parseAgentDispatcherConfig(role);
      if (config) {
        paths.push(config.dispatch_plan_path);
      }
      continue;
    }

    if (role.roleType === "scheduler") {
      const config = parseSchedulerConfig(role);
      if (config && isSchedulerRunActive(config)) {
        paths.push(config.dispatch_plan_path);
      }
    }
  }

  return [...new Set(paths)];
}

function parseAgentDispatcherConfig(roleState: RoleState): AgentDispatcherConfig | null {
  if (roleState.roleType !== "agent-dispatcher") {
    return null;
  }

  const parsed = AgentDispatcherConfigSchema.safeParse(roleState.config);
  return parsed.success ? parsed.data : null;
}

function parseSchedulerConfig(roleState: RoleState): SchedulerConfig | null {
  if (roleState.roleType !== "scheduler") {
    return null;
  }

  const parsed = SchedulerConfigSchema.safeParse(roleState.config);
  return parsed.success ? parsed.data : null;
}

function isSchedulerRunActive(config: SchedulerConfig): boolean {
  try {
    return new SchedulerStateStore(config.dispatch_plan_path).load().status === "active_run";
  } catch {
    return false;
  }
}

function resolveDispatchThreadPath(dispatchPlanPath: string): string {
  return path.join(path.dirname(dispatchPlanPath), DISPATCH_THREADS_FILENAME);
}

async function loadAppState(stateStore: StateStore): Promise<AppState> {
  return (await stateStore.load()) ?? {
    roles: [],
    promptStore: {}
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`startup status probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function main(): Promise<void> {
  const service = await startMeridianRolesService();

  const shutdown = async () => {
    await service.close();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
