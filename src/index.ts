import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { GUI_PORT, RECONCILE_INTERVAL_MS } from "./config";
import { A2AClient } from "./a2a/client";
import { A2AServer } from "./a2a/server";
import { LifecycleStore } from "./roles/agent-dispatcher/lifecycle-store";
import { startPmResolver } from "./roles/agent-dispatcher/pm-resolver";
import { reconcile } from "./roles/agent-dispatcher/reconciler";
import {
  MAX_AUTOMATIC_RECOVERY_RETRIES,
  hasRecoverableDispatchWork,
  isHumanDispatchRow,
  type DispatchContinuationPlanRow
} from "./roles/agent-dispatcher/service-continuation";
import {
  isValidationEnabledForWorker,
  isValidatorResultPassing
} from "./roles/agent-dispatcher/validator-orchestrator";
import { ReconciliationWatchdog } from "./roles/agent-dispatcher/watchdog";
import { FileRelayWatcher } from "./tool-gateway/file-relay";
import killTool from "./tool-gateway/tools/kill";
import { parseDispatchPlanRows, type DispatchPlanWorkerRow } from "./tool-gateway/tools/dispatch-status";
import { AgentDispatcherRole } from "./roles/definitions/agent-dispatcher";
import { SchedulerRole } from "./roles/definitions/scheduler";
import { SchedulerStateStore } from "./roles/scheduler/scheduler-state-store";
import { PromptStore } from "./roles/prompt-store";
import { RoleRegistry } from "./roles/role-registry";
import { RoleRunner, type RehydrationContext } from "./roles/role-runner";
import { createPromptHandlers } from "./server/prompt-handlers";
import { HttpServer } from "./server/http-server";
import { createRoleHandlers, type ContinueDispatcherResponse } from "./server/role-handlers";
import { createSchedulerHandlers } from "./server/scheduler-handlers";
import {
  ACTIVE_ROLE_STATUS,
  PAUSED_ROLE_STATUS,
  NEEDS_REACTIVATION_ROLE_STATUS,
  StateStore,
  isReconcilableAgentDispatcherRoleStatus,
  isStartupRehydratableRoleStatus,
  isTerminalAgentDispatcherRoleStatus
} from "./state-store";
import {
  AgentDispatcherConfigSchema,
  SchedulerConfigSchema,
  type AgentDispatcherConfig,
  type AppState,
  type DispatchThreadStateV2,
  type DispatchWorkerState,
  type HubMessage,
  type HubResult,
  type KillPolicy,
  type RoleState,
  type SchedulerConfig,
  type ValidatorConfig
} from "./types";

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
  const watchdogPmResolverIssueKeys = new Set<string>();

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
  const settleKillThread = async (threadId: string): Promise<void> => {
    const result = await killTool.execute({ thread_id: threadId });
    if (!result.ok) {
      throw new Error(result.error ?? `kill failed for thread ${threadId}`);
    }
  };
  const watchdog = new ReconciliationWatchdog({
    resolveActiveDispatchPlanPaths: () => resolveDispatchPlanPathsFromState(stateStore, {
      killThread: settleKillThread,
      log
    }),
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
    resolveKillPolicyForDispatchPlan: async (dispatchPlanPath) => {
      const state = await loadAppState(stateStore);
      for (const role of state.roles) {
        if (role.roleType === "agent-dispatcher") {
          const config = parseAgentDispatcherConfig(role);
          if (config?.dispatch_plan_path === dispatchPlanPath) {
            return config.kill_policy;
          }
          continue;
        }
        if (role.roleType === "scheduler") {
          const config = parseSchedulerConfig(role);
          if (config?.dispatch_plan_path === dispatchPlanPath) {
            return config.kill_policy;
          }
        }
      }
      return null;
    },
    onDispatcherStalled: async (info) => {
      const threadId = await resolveThreadIdForDispatchPlanPath(stateStore, info.dispatchPlanPath);
      if (!threadId) {
        log.warn("Watchdog stall: no persisted agent-dispatcher found for plan", {
          dispatchPlanPath: info.dispatchPlanPath
        });
        return;
      }

      const directRecovery = await tryContinueDispatchWorker(
        stateStore,
        info.dispatchPlanPath,
        info.continueWorkerId,
        roleHandlers.continueDispatcher,
        log
      );
      if (directRecovery) {
        log.info("Watchdog stall: handled recovery through dispatcher continuation", {
          threadId,
          workerId: directRecovery.workerId,
          status: directRecovery.status,
          message: directRecovery.message
        });
        await maybeStartPmResolverForWatchdogRecovery(
          stateStore,
          threadId,
          directRecovery,
          watchdogPmResolverIssueKeys,
          log
        );
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
  // At startup, stale codex_NN threads for plans that finished while the
  // service was down would otherwise leak — the watchdog only triggers settle
  // for roles still in a non-terminal status, and once buildStartupActivations
  // has flipped them we never get another chance. Best-effort kill via the
  // Hub kill tool; missing-instance replies are swallowed inside the helper.
  const startupSettleKillThread = async (threadId: string): Promise<void> => {
    const result = await killTool.execute({ thread_id: threadId });
    if (!result.ok) {
      throw new Error(result.error ?? `kill failed for thread ${threadId}`);
    }
  };
  const currentState = await settleTerminalAgentDispatcherRoles(stateStore, log, {
    killThread: startupSettleKillThread
  });
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

  for (let probeIndex = 0; probeIndex < validStartupRoles.length; probeIndex += 1) {
    const startupRole = validStartupRoles[probeIndex];
    if (!startupRole) {
      continue;
    }
    const { roleState, index } = startupRole;
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

    let hasRecoverableStartupWork = true;
    if (result.dispatcherConfig) {
      hasRecoverableStartupWork = !result.needsReactivation
        || await hasStartupRecoverableDispatchWork(result.dispatcherConfig);
      const nextStatus = roleState.status === PAUSED_ROLE_STATUS
        ? PAUSED_ROLE_STATUS
        : result.needsReactivation && hasRecoverableStartupWork
          ? NEEDS_REACTIVATION_ROLE_STATUS
          : ACTIVE_ROLE_STATUS;
      if (nextRoleState.status !== nextStatus) {
        nextRoleState.status = nextStatus;
        nextState.roles[index] = nextRoleState;
        stateChanged = true;
      }

      if (result.needsReactivation && hasRecoverableStartupWork) {
        log.warn("Startup rehydration marked dispatcher for reactivation", {
          roleId: roleState.threadId,
          threadId: result.dispatcherThreadId,
          reason: result.failureReason ?? "dispatcher_thread_unavailable"
        });
      }

      if (result.needsReactivation && !hasRecoverableStartupWork) {
        log.info("Startup rehydration skipped dispatcher with no recoverable automatic work", {
          roleId: roleState.threadId,
          threadId: result.dispatcherThreadId,
          reason: result.failureReason ?? "dispatcher_thread_unavailable"
        });
      }
    }

    if (result.dispatcherConfig && result.needsReactivation && !hasRecoverableStartupWork) {
      continue;
    }

    activations.push({
      roleState: nextRoleState,
      rehydrationContext: {
        needsReactivation: result.needsReactivation
      },
      dispatcherConfig: result.dispatcherConfig
    });
  }

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
        await reconcileStartupPmResolvers(lifecycleStore, client, log, dispatchPlanPath);
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

/**
 * Probe each `running` PM resolver against the Hub on service startup.
 * If the Hub no longer routes to the recorded `thread_id`, the PM agent
 * died with the previous service process — there is no live session for
 * the operator to talk into, and leaving the entry as `running` would
 * permanently block worker relaunch via the
 * `findActivePmResolversForWorker` gate. Demote those entries to `failed`
 * via `markPmResolverThreadMissing` (same `reconcilePmStatusAgainstWorkerState`
 * path that promotes back to `completed` if the worker independently
 * recovered while the service was down).
 */
async function reconcileStartupPmResolvers(
  lifecycleStore: LifecycleStore,
  client: A2AClient,
  log: typeof console,
  dispatchPlanPath: string
): Promise<void> {
  const state = lifecycleStore.load();
  const runningEntries = (state.pm_resolvers ?? []).filter((entry) => entry.status === "running");
  if (runningEntries.length === 0) {
    return;
  }

  for (const entry of runningEntries) {
    try {
      const probe = await sendStartupStatusRequest(client, entry.thread_id);
      if (isLiveThreadStatus(probe)) {
        continue;
      }

      const reason = `service_restart_pm_thread_missing: ${extractFailureReason(probe)}`;
      lifecycleStore.markPmResolverThreadMissing(entry.thread_id, reason);
      log.warn("Startup rehydration demoted stale PM resolver", {
        dispatchPlanPath,
        pm_thread_id: entry.thread_id,
        worker_id: entry.issue?.worker_id ?? null,
        reason
      });
    } catch (error) {
      log.warn("Startup PM resolver probe failed", {
        dispatchPlanPath,
        pm_thread_id: entry.thread_id,
        worker_id: entry.issue?.worker_id ?? null,
        error: asError(error).message
      });
    }
  }
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

export type WatchdogContinueDispatcher = (
  threadId: string,
  workerId?: string
) => Promise<ContinueDispatcherResponse>;

export interface WatchdogContinueResult {
  status: ContinueDispatcherResponse["status"];
  workerId: string | null;
  message: string;
}

const PM_RESOLVER_WATCHDOG_STATUSES = new Set<ContinueDispatcherResponse["status"]>([
  "manual_intervention_required",
  "local_tool_bootstrap_failed"
]);

async function maybeStartPmResolverForWatchdogRecovery(
  stateStore: StateStore,
  threadId: string,
  recovery: WatchdogContinueResult,
  seenIssueKeys: Set<string>,
  log: typeof console
): Promise<void> {
  const state = await loadAppState(stateStore);
  const roleState = state.roles.find((role) => role.threadId === threadId);
  if (!roleState) {
    log.warn("Watchdog stall: cannot start PM resolver because dispatcher state is missing", { threadId });
    return;
  }

  const config = parseAgentDispatcherConfig(roleState);
  if (!config) {
    log.warn("Watchdog stall: cannot start PM resolver because dispatcher config is invalid", { threadId });
    return;
  }

  let lifecycleState: DispatchThreadStateV2 | null = null;
  try {
    lifecycleState = new LifecycleStore(resolveDispatchThreadPath(config.dispatch_plan_path)).load();
  } catch (error) {
    log.warn("Watchdog stall: cannot inspect PM resolver lifecycle state", {
      threadId,
      workerId: recovery.workerId,
      error: asError(error).message
    });
  }

  let issueStatus: ContinueDispatcherResponse["status"] = recovery.status;
  let issueWorkerId = recovery.workerId;
  let issueMessage = recovery.message;
  if (!PM_RESOLVER_WATCHDOG_STATUSES.has(recovery.status)) {
    const exhaustedWorkerId = lifecycleState ? resolveRetryExhaustedWorkerNeedingPm(lifecycleState) : null;
    if (!exhaustedWorkerId) {
      return;
    }

    const exhaustedStatus = lifecycleState?.workers[exhaustedWorkerId]?.status ?? "terminal";
    issueStatus = "manual_intervention_required";
    issueWorkerId = exhaustedWorkerId;
    issueMessage = `manual intervention required: ${exhaustedWorkerId} exhausted automatic retries after ${exhaustedStatus}`;
  }

  const issueKey = [
    threadId,
    issueStatus,
    issueWorkerId ?? ""
  ].join("\u0000");
  if (seenIssueKeys.has(issueKey)) {
    log.info("Watchdog stall: PM resolver already requested for this issue", {
      threadId,
      workerId: issueWorkerId,
      status: issueStatus
    });
    return;
  }

  if (lifecycleState && hasPmResolverHandledCurrentWorkerIssue(lifecycleState, issueWorkerId)) {
    seenIssueKeys.add(issueKey);
    log.info("Watchdog stall: PM resolver already handled current worker issue", {
      threadId,
      workerId: issueWorkerId,
      status: issueStatus
    });
    return;
  }

  seenIssueKeys.add(issueKey);
  try {
    const result = await startPmResolver({
      dispatcherId: threadId,
      config,
      issue: {
        status: issueStatus,
        workerId: issueWorkerId ?? undefined,
        message: issueMessage,
        source: "watchdog"
      }
    });
    log.info("Watchdog stall: PM resolver handoff completed", {
      threadId,
      workerId: issueWorkerId,
      status: issueStatus,
      pmResolverStatus: result.status,
      pmResolverThreadId: result.status === "pm_resolver_started" ? result.thread_id : undefined,
      message: result.message
    });
    if (result.status !== "pm_resolver_started") {
      seenIssueKeys.delete(issueKey);
    }
  } catch (error) {
    seenIssueKeys.delete(issueKey);
    log.warn("Watchdog stall: PM resolver handoff failed", {
      threadId,
      workerId: issueWorkerId,
      status: issueStatus,
      error: asError(error).message
    });
  }
}

export function hasPmResolverHandledCurrentWorkerIssue(
  state: Pick<DispatchThreadStateV2, "workers" | "pm_resolvers">,
  workerId: string | null | undefined
): boolean {
  const normalizedWorkerId = workerId?.trim();
  if (!normalizedWorkerId) {
    return false;
  }

  const workerStartedAt = state.workers[normalizedWorkerId]?.started_at;
  const workerStartedAtMs = workerStartedAt ? Date.parse(workerStartedAt) : NaN;

  return (state.pm_resolvers ?? []).some((entry) => {
    if (entry.status === "failed") {
      return false;
    }

    if ((entry.issue.worker_id ?? "").trim() !== normalizedWorkerId) {
      return false;
    }

    if (Number.isNaN(workerStartedAtMs)) {
      return true;
    }

    const entryStartedAtMs = Date.parse(entry.started_at);
    return !Number.isNaN(entryStartedAtMs) && entryStartedAtMs >= workerStartedAtMs;
  });
}

export function resolveRetryExhaustedWorkerNeedingPm(
  state: Pick<DispatchThreadStateV2, "workers" | "pm_resolvers">
): string | null {
  for (const [workerId, worker] of Object.entries(state.workers)) {
    if (worker.status !== "abandoned" && worker.status !== "failed") {
      continue;
    }
    if ((worker.retry_count ?? 0) < MAX_AUTOMATIC_RECOVERY_RETRIES) {
      continue;
    }
    if (hasPmResolverHandledCurrentWorkerIssue(state, workerId)) {
      continue;
    }

    return workerId;
  }

  return null;
}

export async function tryContinueDispatchWorker(
  stateStore: StateStore,
  dispatchPlanPath: string,
  workerId: string | null,
  continueDispatcher: WatchdogContinueDispatcher,
  log: typeof console
): Promise<WatchdogContinueResult | null> {
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

  try {
    const continued = await continueDispatcher(roleState.threadId, workerId);
    if (isActiveContinuationStatus(continued.status)) {
      await persistAgentDispatcherRoleStatus(stateStore, roleState.threadId, ACTIVE_ROLE_STATUS, log);
    }

    return {
      status: continued.status,
      workerId: continued.worker ?? workerId,
      message: continued.message
    };
  } catch (error) {
    log.warn("Watchdog dispatcher continuation failed", {
      dispatchPlanPath,
      workerId,
      error: asError(error).message
    });
    return null;
  }
}

function isActiveContinuationStatus(status: ContinueDispatcherResponse["status"]): boolean {
  return status === "continued"
    || status === "validation_in_progress"
    || status === "validation_feedback_delivered";
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

export interface ResolveDispatchPlanPathsOptions {
  /**
   * Best-effort thread-kill hook invoked once per thread_id when a dispatcher
   * role is freshly flipped to a terminal status. Production wires this to the
   * Hub kill tool so threads recorded under a settled plan (dispatcher,
   * worker, validator, pm-resolver) do not outlive the plan. Tests omit the
   * hook to avoid touching the network.
   */
  killThread?: (threadId: string) => Promise<void>;
  log?: Pick<Console, "info" | "warn">;
}

export async function resolveDispatchPlanPathsFromState(
  stateStore: StateStore,
  options: ResolveDispatchPlanPathsOptions = {}
): Promise<string[]> {
  const state = await settleTerminalAgentDispatcherRoles(stateStore, options.log, {
    killThread: options.killThread
  });
  const paths: string[] = [];

  for (const role of state.roles) {
    if (role.roleType === "agent-dispatcher") {
      if (!isReconcilableAgentDispatcherRoleStatus(role.status)) {
        continue;
      }

      const config = parseAgentDispatcherConfig(role);
      if (config) {
        if (!isTerminalAgentDispatcherRoleStatus(role.status)) {
          paths.push(config.dispatch_plan_path);
          continue;
        }

        const terminalStatus = await resolveSettledDispatchPlanRoleStatus(config);
        if (!terminalStatus) {
          paths.push(config.dispatch_plan_path);
        }
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

export interface SettleTerminalAgentDispatcherOptions {
  /**
   * Best-effort thread-kill hook invoked once per thread_id when a dispatcher
   * role is flipped from non-terminal to terminal. Threads that survived the
   * watchdog's per-tick `cleanupTerminalWorkerThreads` (e.g. a worker that
   * settled in the same tick the plan completed, or a `kill_policy=on_success`
   * worker that ended up `failed`) would otherwise leak in the Hub forever
   * because the watchdog excludes settled paths from subsequent sweeps.
   */
  killThread?: (threadId: string) => Promise<void>;
}

export async function settleTerminalAgentDispatcherRoles(
  stateStore: StateStore,
  log?: Pick<Console, "info" | "warn">,
  options: SettleTerminalAgentDispatcherOptions = {}
): Promise<AppState> {
  const state = await loadAppState(stateStore);
  let stateChanged = false;

  for (const role of state.roles) {
    if (role.roleType !== "agent-dispatcher" || isTerminalAgentDispatcherRoleStatus(role.status)) {
      continue;
    }

    const config = parseAgentDispatcherConfig(role);
    if (!config) {
      continue;
    }

    const terminalStatus = await resolveSettledDispatchPlanRoleStatus(config);
    if (!terminalStatus) {
      continue;
    }

    role.status = terminalStatus;
    stateChanged = true;
    log?.info?.("Agent-dispatcher plan is terminal; skipping active rehydration", {
      roleId: role.threadId,
      status: terminalStatus,
      dispatchPlanPath: config.dispatch_plan_path
    });

    if (options.killThread) {
      await cleanupSettledDispatchPlanThreads(config, options.killThread, log);
    }
  }

  if (stateChanged) {
    await stateStore.save(state);
  }

  return state;
}

/**
 * Best-effort terminate every Hub thread the lifecycle still records for a
 * dispatch plan that has just settled (role flipped from non-terminal to
 * `completed`/`failed`). Mirrors `AgentDispatcherRole.onDeactivate` but covers
 * the gap that role.onDeactivate is never called on settle, and that its
 * `loadTrackedThreads` only includes `running` workers — terminal-status
 * workers whose threads outlived their work would slip through.
 *
 * The dispatcher's own thread is killed regardless of `kill_policy` (matches
 * onDeactivate). Worker / validator / pm-resolver threads honor
 * `kill_policy`: `never` leaves them intact (operator may want to inspect
 * post-mortem), `always`/`on_success` kill anything still recorded.
 *
 * Kill failures are swallowed; the Hub's "no registered agent instance" reply
 * is the expected response when a worker thread already exited cleanly.
 */
async function cleanupSettledDispatchPlanThreads(
  config: AgentDispatcherConfig,
  killThread: (threadId: string) => Promise<void>,
  log?: Pick<Console, "info" | "warn">
): Promise<void> {
  let lifecycleState: DispatchThreadStateV2;
  try {
    lifecycleState = new LifecycleStore(resolveDispatchThreadPath(config.dispatch_plan_path)).load();
  } catch {
    return;
  }

  const threadIds = new Set<string>();

  const dispatcherThreadId = lifecycleState.dispatcher.thread_id?.trim();
  if (dispatcherThreadId) {
    threadIds.add(dispatcherThreadId);
  }

  if (config.kill_policy !== "never") {
    for (const worker of Object.values(lifecycleState.workers)) {
      const workerThreadId = worker.thread_id?.trim();
      if (workerThreadId && shouldKillSettledWorker(worker, config.kill_policy)) {
        threadIds.add(workerThreadId);
      }
      const validatorThreadId = worker.validation?.validator_thread_id?.trim();
      if (validatorThreadId) {
        threadIds.add(validatorThreadId);
      }
    }
    for (const pmResolver of lifecycleState.pm_resolvers ?? []) {
      const pmThreadId = pmResolver.thread_id?.trim();
      if (pmThreadId) {
        threadIds.add(pmThreadId);
      }
    }
  }

  for (const threadId of threadIds) {
    try {
      await killThread(threadId);
    } catch (error) {
      const message = asError(error).message;
      if (isMissingThreadKillReply(message)) {
        continue;
      }
      log?.warn?.("Settle-time thread cleanup failed", {
        dispatchPlanPath: config.dispatch_plan_path,
        threadId,
        error: message
      });
    }
  }
}

function shouldKillSettledWorker(worker: DispatchWorkerState, killPolicy: KillPolicy): boolean {
  if (killPolicy === "always") {
    return worker.status === "completed"
      || worker.status === "failed"
      || worker.status === "blocked"
      || worker.status === "abandoned"
      || worker.status === "skipped";
  }
  if (killPolicy === "on_success") {
    return worker.status === "completed";
  }
  return false;
}

function isMissingThreadKillReply(message: string): boolean {
  return /\bnot found\b/i.test(message)
    || /\bmissing\b/i.test(message)
    || /\bunknown thread\b/i.test(message)
    || /no registered agent instance/i.test(message);
}

export async function hasStartupRecoverableDispatchWork(config: AgentDispatcherConfig): Promise<boolean> {
  let lifecycleState: DispatchThreadStateV2;
  let rows: DispatchContinuationPlanRow[];

  try {
    lifecycleState = new LifecycleStore(resolveDispatchThreadPath(config.dispatch_plan_path)).load();
    const parsedRows = parseDispatchPlanRows(await fs.readFile(config.dispatch_plan_path, "utf8"));
    rows = parsedRows.map(toContinuationRow);
  } catch {
    return true;
  }

  return hasRecoverableDispatchWork(rows, lifecycleState);
}

async function resolveSettledDispatchPlanRoleStatus(
  config: AgentDispatcherConfig
): Promise<"completed" | "failed" | null> {
  let lifecycleState: DispatchThreadStateV2;
  let rows: DispatchPlanWorkerRow[];

  try {
    lifecycleState = new LifecycleStore(resolveDispatchThreadPath(config.dispatch_plan_path)).load();
    rows = parseDispatchPlanRows(await fs.readFile(config.dispatch_plan_path, "utf8"));
  } catch {
    return null;
  }

  const nonHumanRows = rows.filter((row) => !isHumanDispatchRow(toContinuationRow(row)) && row.worker_id.trim().length > 0);
  if (nonHumanRows.length === 0) {
    return null;
  }

  const terminalStatuses = nonHumanRows.map((row) => resolveSettledDispatchRowStatus(row, lifecycleState, config.validator));
  if (terminalStatuses.some((status) => status === null)) {
    return null;
  }

  return terminalStatuses.some((status) => status === "failed") ? "failed" : "completed";
}

function resolveSettledDispatchRowStatus(
  row: DispatchPlanWorkerRow,
  lifecycleState: DispatchThreadStateV2,
  validatorConfig?: ValidatorConfig
): "completed" | "failed" | null {
  const worker = lifecycleState.workers[row.worker_id];
  if (!worker) {
    return null;
  }

  const planStatus = row.status.trim();
  if (
    worker.status === "completed"
    && (planStatus === "✅" || planStatus === "🔄")
    && isCompletedWorkerValidationSatisfied(row, lifecycleState, validatorConfig)
  ) {
    return "completed";
  }

  if (worker.status === "skipped" && (planStatus === "⛔ SKIPPED" || planStatus === "🔄")) {
    return "completed";
  }

  if (
    (worker.status === "failed" || worker.status === "blocked" || worker.status === "abandoned")
    && (planStatus === "❌" || planStatus === "⛔ BLOCKED" || planStatus === "⚠️ ABANDONED" || planStatus === "🔄")
  ) {
    return "failed";
  }

  return null;
}

function isCompletedWorkerValidationSatisfied(
  row: DispatchPlanWorkerRow,
  lifecycleState: DispatchThreadStateV2,
  validatorConfig?: ValidatorConfig
): boolean {
  const continuationRow = toContinuationRow(row);
  if (!validatorConfig?.enabled || !isValidationEnabledForWorker(validatorConfig, continuationRow)) {
    return true;
  }

  const score = lifecycleState.workers[row.worker_id]?.validation?.last_score;
  return typeof score === "number" && isValidatorResultPassing(validatorConfig, continuationRow, score);
}

function toContinuationRow(row: DispatchPlanWorkerRow): DispatchContinuationPlanRow {
  return {
    status: row.status,
    batch: row.batch,
    worker: row.worker_id,
    model: row.model,
    depends_on: row.depends_on,
    notes: row.notes
  };
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
