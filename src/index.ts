import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { GUI_PORT, RECONCILE_INTERVAL_MS } from "./config";
import { A2AClient } from "./a2a/client";
import { A2AServer } from "./a2a/server";
import { resolveOtherDispatcherPlanPaths } from "./roles/agent-dispatcher/cross-plan-paths";
import {
  DispatcherWorkerBreaker,
  computeWorkerLifecycleSig
} from "./roles/agent-dispatcher/circuit-breaker";
import { LifecycleStore } from "./roles/agent-dispatcher/lifecycle-store";
import { parseMeridianStatusMarker } from "./roles/agent-dispatcher/meridian-status-marker";
import { startPmResolver } from "./roles/agent-dispatcher/pm-resolver";
import { reconcile } from "./roles/agent-dispatcher/reconciler";
import { findMostRecentOutputArtifactMtimeMs } from "./roles/agent-dispatcher/output-artifacts";
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
import { createProcessHandlers } from "./server/process-handlers";
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
    log,
    // On launch-breaker trip: persist PAUSED to the state store so the GUI's
    // role detail page reflects reality (the role is no longer being
    // launched) instead of looping users through reactivation that just
    // re-trips. Operator must explicitly resume after fixing the underlying
    // cause (typically Meridian Hub at :3000 unreachable / overloaded).
    onLaunchBreakerTripped: async (dispatcherRoleId) => {
      try {
        const appState = await loadAppState(stateStore);
        const nextRoles = appState.roles.map((role) =>
          role.threadId === dispatcherRoleId
            ? { ...role, status: PAUSED_ROLE_STATUS }
            : role
        );
        await stateStore.save({ roles: nextRoles, promptStore: appState.promptStore });
      } catch (e) {
        log.warn("Failed to persist PAUSED on launch breaker trip", {
          dispatcherRoleId,
          error: e instanceof Error ? e.message : String(e)
        });
      }
    }
  });
  const resultServer = new A2AServer((result) => runner.dispatch(result), { log });
  const watchdogPmResolverIssueKeys = new Set<string>();
  // Per-(dispatcherId, workerId) circuit breaker — kills the runaway
  // continueDispatcher loop that drove agent-dispatcher-67f6a3fc to ~3,500
  // wasted LLM dispatches before pause was reliable. See
  // docs/plans/2026-05-16-dispatcher-circuit-breaker-and-real-pause-design.md.
  const dispatcherWorkerBreaker = new DispatcherWorkerBreaker();

  registry.register("dispatcher", (threadId, config) => new AgentDispatcherRole(threadId, config, { stateStore }));
  registry.register("agent-dispatcher", (threadId, config) => new AgentDispatcherRole(threadId, config, { stateStore }));
  registry.register("scheduler", (threadId, config) => new SchedulerRole(threadId, config, { stateStore }));

  const startupActivations = await buildStartupActivations(stateStore, client, log);
  await reconcileStartupDispatchers(startupActivations, client, log);

  // Safety hold: force every persisted agent-dispatcher role to PAUSED before
  // activating it. Prevents the loop class where ANY auto-spawn on restart
  // (dispatcher controller, watchdog respawn, PM resolver liveness sweep,
  // worker-launcher off a rehydrated dispatch_plan) can fire before the
  // operator has verified the host is healthy (Hub up, no orphans, etc.).
  // Opt out by setting MERIDIAN_ROLES_AUTO_RESUME_ON_RESTART=true.
  const autoResume = (process.env.MERIDIAN_ROLES_AUTO_RESUME_ON_RESTART ?? "").toLowerCase() === "true";
  if (!autoResume) {
    await forcePauseAllDispatchersOnStartup(stateStore, log);
  } else {
    log.warn("MERIDIAN_ROLES_AUTO_RESUME_ON_RESTART=true — skipping restart hold; dispatchers will auto-activate");
  }

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
  const processHandlers = createProcessHandlers({
    stateStore,
    log,
    // Hub TCP-port path: agentapi argv has no /tmp/agentapi-<id>.sock when
    // --socket isn't supported, so we fall back to the Hub's instance
    // registry (pid → thread_id) to attribute processes to dispatchers.
    fetchAgentapiInstanceIndex: async () => {
      const instances = await client.listInstances();
      const map = new Map<number, string>();
      for (const inst of instances) {
        if (typeof inst.pid === "number" && inst.pid > 0 && inst.thread_id) {
          map.set(inst.pid, inst.thread_id);
        }
      }
      return map;
    }
  });
  const httpServer = new HttpServer({
    port: GUI_PORT,
    roleHandlers,
    promptHandlers,
    schedulerHandlers,
    processHandlers,
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

      // Circuit breaker gate: bound how often the watchdog can re-fire
      // continueDispatcher against the same stuck worker. A worker that's
      // genuinely making progress will see its lifecycleSig change and the
      // breaker counter reset; only true loops accumulate to the trip
      // threshold (10 calls / 10 min by default).
      const breakerVerdict = await evaluateBreakerForWatchdog(
        info.dispatchPlanPath,
        info.continueWorkerId,
        threadId,
        dispatcherWorkerBreaker,
        log
      );
      if (breakerVerdict && !breakerVerdict.allowed) {
        await handleBreakerTrip(
          threadId,
          info.continueWorkerId,
          info.dispatchPlanPath,
          breakerVerdict.countAfter,
          breakerVerdict.lifecycleSig,
          runner,
          stateStore,
          log
        );
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

/**
 * Restart safety hold: flips every non-terminal agent-dispatcher role to
 * PAUSED in state.json BEFORE activation. Subsequent activate() reads PAUSED
 * via SessionManager.loadPauseState and the role enters paused, so the
 * watchdog's isDispatcherPaused gate prevents any spawn (controller relaunch,
 * worker spawn, PM resolver, validator) until the operator explicitly hits
 * Resume on each role.
 *
 * This is the safety net for the class of restart-time spawn loops that
 * neither the launch breaker nor the worker circuit breaker can prevent —
 * because the loop's first iteration already happened by the time those
 * breakers see their first request.
 */
export async function forcePauseAllDispatchersOnStartup(
  stateStore: StateStore,
  log: typeof console
): Promise<void> {
  let pausedCount = 0;
  let skippedTerminal = 0;
  const state = await loadAppState(stateStore);
  const TERMINAL_STATUSES = new Set(["completed", "failed", "deactivated", "terminated"]);
  const nextRoles = state.roles.map((role) => {
    if (role.roleType !== "agent-dispatcher") {
      return role;
    }
    if (TERMINAL_STATUSES.has(role.status)) {
      skippedTerminal += 1;
      return role;
    }
    if (role.status === PAUSED_ROLE_STATUS) {
      return role; // already paused
    }
    pausedCount += 1;
    return { ...role, status: PAUSED_ROLE_STATUS };
  });
  if (pausedCount > 0) {
    await stateStore.save({ roles: nextRoles, promptStore: state.promptStore });
    log.warn("Restart safety hold: forced PAUSED on agent-dispatcher roles", {
      paused: pausedCount,
      skippedTerminal,
      hint: "Resume each dispatcher via the GUI/CLI once you've verified Hub is healthy. Set MERIDIAN_ROLES_AUTO_RESUME_ON_RESTART=true to disable this hold."
    });
  } else {
    log.info("Restart safety hold: no non-paused dispatchers to hold", { skippedTerminal });
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

// Reads the worker's current lifecycle entry to derive a stable signature, then
// asks the breaker whether the next watchdog continuation is allowed. Returns
// null when there's no candidate workerId — the breaker only meaningfully gates
// per-worker continuations.
async function evaluateBreakerForWatchdog(
  dispatchPlanPath: string,
  candidateWorkerId: string | null,
  dispatcherThreadId: string,
  breaker: DispatcherWorkerBreaker,
  log: typeof console
): Promise<{ allowed: boolean; countAfter: number; lifecycleSig: string } | null> {
  if (!candidateWorkerId) {
    return null;
  }
  let startedAt: string | null = null;
  let status: string | null = null;
  try {
    const lifecycleState = new LifecycleStore(
      path.join(path.dirname(dispatchPlanPath), DISPATCH_THREADS_FILENAME)
    ).load();
    const worker = lifecycleState.workers[candidateWorkerId];
    startedAt = worker?.started_at ?? null;
    status = worker?.status ?? null;
  } catch (error) {
    // If we can't read the lifecycle file, fall back to a sig that only
    // captures the workerId. That degrades the breaker's progress-detection
    // (the counter won't reset on a status flip) but keeps it functional.
    log.warn("Watchdog stall: breaker fell back to workerId-only sig", {
      dispatchPlanPath,
      workerId: candidateWorkerId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  const lifecycleSig = computeWorkerLifecycleSig(candidateWorkerId, startedAt, status);
  return breaker.shouldAllow(dispatcherThreadId, candidateWorkerId, lifecycleSig, Date.now());
}

// Stamp circuit_open on the worker's lifecycle entry, force-pause the
// dispatcher (real pause kills attached agentapi threads), and emit a loud
// structured log so the operator sees it in the GUI's role log stream.
async function handleBreakerTrip(
  dispatcherThreadId: string,
  workerId: string | null,
  dispatchPlanPath: string,
  countAfter: number,
  lifecycleSig: string,
  runner: RoleRunner,
  stateStore: StateStore,
  log: typeof console
): Promise<void> {
  log.error("Watchdog stall: circuit breaker tripped — force-pausing dispatcher", {
    dispatcherThreadId,
    workerId,
    countAfter,
    lifecycleSig
  });

  try {
    const lifecycleStore = new LifecycleStore(
      path.join(path.dirname(dispatchPlanPath), DISPATCH_THREADS_FILENAME)
    );
    const state = lifecycleStore.load();
    if (workerId && state.workers[workerId]) {
      const worker = state.workers[workerId];
      (worker as DispatchWorkerState & { circuit_open?: unknown }).circuit_open = {
        since: new Date().toISOString(),
        count: countAfter,
        lifecycle_sig: lifecycleSig,
        reason: "watchdog_continue_loop_without_progress"
      };
      lifecycleStore.save(state);
    }
  } catch (error) {
    log.warn("Watchdog stall: failed to stamp circuit_open marker", {
      dispatcherThreadId,
      workerId,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  // Force-pause via the runner — this triggers session-manager's real-pause
  // path which enumerates attached threads and SIGTERM/SIGKILLs them.
  try {
    const paused = await runner.pauseRole(dispatcherThreadId);
    if (!paused) {
      log.warn("Watchdog stall: pauseRole returned false during circuit trip", {
        dispatcherThreadId
      });
    }
  } catch (error) {
    log.error("Watchdog stall: pauseRole threw during circuit trip", {
      dispatcherThreadId,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  // Also reflect the paused status in the state store directly so operators
  // see it immediately, in case the role's own persist path was interrupted.
  try {
    const appState = await loadAppState(stateStore);
    const nextRoles = appState.roles.map((role) =>
      role.threadId === dispatcherThreadId
        ? { ...role, status: PAUSED_ROLE_STATUS }
        : role
    );
    await stateStore.save({ roles: nextRoles, promptStore: appState.promptStore });
  } catch (error) {
    log.warn("Watchdog stall: failed to write paused status to state store", {
      dispatcherThreadId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
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

export function buildWatchdogPmResolverIssueKey(
  threadId: string,
  issueStatus: ContinueDispatcherResponse["status"],
  issueWorkerId: string | null | undefined,
  workerStartedAt: string | null | undefined
): string {
  return [
    threadId,
    issueStatus,
    issueWorkerId ?? "",
    workerStartedAt ?? ""
  ].join("\u0000");
}

export interface AssertPmResolverSpawnAllowedInput {
  threadId: string;
  issueStatus: ContinueDispatcherResponse["status"];
  issueWorkerId: string | null;
  lifecycleState: DispatchThreadStateV2 | null;
  seenIssueKeys: Set<string>;
  log: typeof console;
}

export interface AssertPmResolverSpawnAllowedVerdict {
  allowed: boolean;
  issueKey: string;
}

/**
 * Single source of truth for whether a PM resolver spawn is allowed on this
 * (threadId, workerId, issueStatus) tuple. Encapsulates the dedupe-cache
 * check, the lifecycle-eviction-aware stale-cache recovery (PR #214 follow-up
 * for agent-dispatcher-67f6a3fc BATCH-5-GATE), and the "PM already handled
 * this worker run" short-circuit. Every PM resolver spawn entry must funnel
 * through this helper so the invariants cannot drift between sites.
 *
 * Side effect: may mutate `seenIssueKeys` (delete on stale-cache recovery,
 * add when short-circuiting because PM already handled the issue).
 */
export function assertPmResolverSpawnAllowed(
  input: AssertPmResolverSpawnAllowedInput
): AssertPmResolverSpawnAllowedVerdict {
  const { threadId, issueStatus, issueWorkerId, lifecycleState, seenIssueKeys, log } = input;
  const workerStartedAtForKey = issueWorkerId
    ? lifecycleState?.workers[issueWorkerId]?.started_at ?? null
    : null;
  const issueKey = buildWatchdogPmResolverIssueKey(
    threadId,
    issueStatus,
    issueWorkerId,
    workerStartedAtForKey
  );
  if (seenIssueKeys.has(issueKey)) {
    if (lifecycleState && !hasPmResolverHandledCurrentWorkerIssue(lifecycleState, issueWorkerId)) {
      seenIssueKeys.delete(issueKey);
    } else {
      log.info("Watchdog stall: PM resolver already requested for this issue", {
        threadId,
        workerId: issueWorkerId,
        status: issueStatus
      });
      return { allowed: false, issueKey };
    }
  }

  if (lifecycleState && hasPmResolverHandledCurrentWorkerIssue(lifecycleState, issueWorkerId)) {
    seenIssueKeys.add(issueKey);
    log.info("Watchdog stall: PM resolver already handled current worker issue", {
      threadId,
      workerId: issueWorkerId,
      status: issueStatus
    });
    return { allowed: false, issueKey };
  }

  return { allowed: true, issueKey };
}

export async function maybeStartPmResolverForWatchdogRecovery(
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

  // The set is process-lifetime and previously was only deleted on PM spawn
  // failure, so a successful PM that "recovered" a worker to `pending` left
  // its key cached forever. The next worker run that re-emitted needs_pm /
  // blocked short-circuited here before reaching the time-aware lifecycle
  // gate `hasPmResolverHandledCurrentWorkerIssue` below (observed on
  // agent-dispatcher-8eb13a31 BATCH-3-GATE: PM codex_11 recovered the worker,
  // codex_17 relaunched, re-emitted needs_pm, then no new PM ever spawned).
  // Folding `worker.started_at` into the key mirrors the same time semantics
  // the lifecycle gate already enforces, so a fresh worker run gets a fresh
  // key. Fall back to the legacy key when the worker is absent.
  const verdict = assertPmResolverSpawnAllowed({
    threadId,
    issueStatus,
    issueWorkerId,
    lifecycleState,
    seenIssueKeys,
    log
  });
  if (!verdict.allowed) {
    return;
  }
  const issueKey = verdict.issueKey;

  seenIssueKeys.add(issueKey);
  const otherDispatchPlanPaths = await resolveOtherDispatcherPlanPaths(stateStore, threadId);
  try {
    const result = await startPmResolver({
      dispatcherId: threadId,
      config,
      issue: {
        status: issueStatus,
        workerId: issueWorkerId ?? undefined,
        message: issueMessage,
        source: "watchdog"
      },
      otherDispatchPlanPaths
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

  const worker = state.workers[normalizedWorkerId];
  const workerStartedAt = worker?.started_at;
  const workerStartedAtMs = workerStartedAt ? Date.parse(workerStartedAt) : NaN;
  // Operator override: once a human explicitly resumes via /human-resolve, the
  // escalation verdict is consumed. Subsequent escalation-style PM entries
  // that pre-date the human acknowledgement stop closing the gate so the
  // dispatcher can spawn a fresh PM if the worker re-blocks after recovery.
  const humanResolvedAt = worker?.human_resolution?.resolved_at ?? null;
  const humanResolvedAtMs = humanResolvedAt ? Date.parse(humanResolvedAt) : NaN;

  return (state.pm_resolvers ?? []).some((entry) => {
    if ((entry.issue.worker_id ?? "").trim() !== normalizedWorkerId) {
      return false;
    }

    // Escalation freeze: when the PM marker emitted `escalate_human` and no
    // human has acknowledged via /human-resolve since that entry, the
    // dispatcher must stop spawning further PM resolvers regardless of how
    // many times the worker has since been retried. Without this, each
    // operator (or force-true) retry advances worker.started_at past the
    // escalation entry and reopens the gate, producing the PM-storm shape
    // observed on agent-dispatcher-67f6a3fc W-15 on 2026-05-15 (codex_49 →
    // 51 → 52 → 54 escalate_human → 55 → 56 → 58 within 30 minutes against
    // an unresolvable Cloudflare credential blocker) and recurring on E-03
    // on the same dispatcher (codex_66 → 67 → 68 within 12 minutes against
    // an unresolvable Cloudflare credential blocker).
    //
    // This check runs BEFORE the `status === "failed"` short-circuit because
    // `recordPmResolverResult` writes status="failed" for escalation markers
    // (so `reconcilePmResolversForRecoveredWorker` can later promote on
    // worker recovery). The marker is the authoritative signal; envelope
    // status alone must not be allowed to drop the freeze.
    //
    // `effectivePmAction` also falls back to re-parsing `entry.result.content`
    // when the persisted `marker_pm_action` field is null. This recovers
    // entries that were written by pre-#219 binaries (no schema for the
    // marker fields) but whose reply text still contains a valid
    // `<<<MERIDIAN-STATUS>>> pm_action: escalate_human` block. Without this
    // backfill, a meridian-roles restart that lands while an escalation is
    // already on disk would not see those entries as handled and would
    // respawn another PM on the next watchdog sweep.
    //
    // Released only when /human-resolve stamps a
    // `human_resolution.resolved_at` newer than this entry's last_seen_at.
    const effectivePmAction = effectivePmResolverAction(entry, normalizedWorkerId);
    if (effectivePmAction === "escalate_human") {
      const entryLastSeenAtMs = Date.parse(entry.last_seen_at);
      const released = !Number.isNaN(humanResolvedAtMs)
        && !Number.isNaN(entryLastSeenAtMs)
        && humanResolvedAtMs >= entryLastSeenAtMs;
      if (!released) {
        return true;
      }
      // Released: fall through to the normal status / timing checks below.
    }

    if (entry.status === "failed") {
      return false;
    }

    if (Number.isNaN(workerStartedAtMs)) {
      return true;
    }

    const entryStartedAtMs = Date.parse(entry.started_at);
    return !Number.isNaN(entryStartedAtMs) && entryStartedAtMs >= workerStartedAtMs;
  });
}

/**
 * Return the PM resolver action for a lifecycle entry, preferring the
 * persisted `marker_pm_action` field and falling back to re-parsing the
 * stored reply content. The fallback handles entries written by pre-#219
 * binaries (where the field did not exist on the schema). The re-parsed
 * marker is only honoured when its role is `pm-resolver` AND its worker_id
 * matches the entry's target — same constraint as `recordPmResolverResult`,
 * so cross-talk content from a thread-id-collision bleed cannot synthesise a
 * false escalation freeze.
 */
function effectivePmResolverAction(
  entry: NonNullable<DispatchThreadStateV2["pm_resolvers"]>[number],
  targetWorkerId: string
): string | null {
  if (entry.marker_pm_action !== null) {
    return entry.marker_pm_action;
  }
  const content = entry.result?.content;
  if (typeof content !== "string" || content.length === 0) {
    return null;
  }
  const marker = parseMeridianStatusMarker(content);
  if (!marker || marker.role !== "pm-resolver" || marker.worker_id !== targetWorkerId) {
    return null;
  }
  return marker.pm_action ?? null;
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
 * A "no registered agent instance" reply is the expected response when a
 * worker thread already exited cleanly, but it is also the symptom of a
 * fake-kill leak (Hub unregistered the thread without waiting for the
 * agentapi process group to exit; the codex/claude CLI subprocess stays
 * alive). We emit a `lifecycle_cleanup_missing_thread` info entry so that
 * operators can grep for orphan codex CLIs (`ps -axo pid,lstart,command |
 * rg 'codex exec'`) after a settle that should have reaped everything.
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
  const threadIdToWorkerId = new Map<string, string>();

  const dispatcherThreadId = lifecycleState.dispatcher.thread_id?.trim();
  if (dispatcherThreadId) {
    threadIds.add(dispatcherThreadId);
    threadIdToWorkerId.set(dispatcherThreadId, "DISPATCHER");
  }

  if (config.kill_policy !== "never") {
    for (const [workerId, worker] of Object.entries(lifecycleState.workers)) {
      const workerThreadId = worker.thread_id?.trim();
      if (workerThreadId && shouldKillSettledWorker(worker, config.kill_policy)) {
        threadIds.add(workerThreadId);
        threadIdToWorkerId.set(workerThreadId, workerId);
      }
      const validatorThreadId = worker.validation?.validator_thread_id?.trim();
      if (validatorThreadId) {
        threadIds.add(validatorThreadId);
        threadIdToWorkerId.set(validatorThreadId, `${workerId}:validator`);
      }
    }
    for (const pmResolver of lifecycleState.pm_resolvers ?? []) {
      const pmThreadId = pmResolver.thread_id?.trim();
      if (pmThreadId) {
        threadIds.add(pmThreadId);
        threadIdToWorkerId.set(pmThreadId, `${pmResolver.issue?.worker_id ?? "?"}:pm`);
      }
    }
  }

  for (const threadId of threadIds) {
    try {
      await killThread(threadId);
    } catch (error) {
      const message = asError(error).message;
      if (isMissingThreadKillReply(message)) {
        log?.info?.("lifecycle_cleanup_missing_thread", {
          dispatchPlanPath: config.dispatch_plan_path,
          threadId,
          workerId: threadIdToWorkerId.get(threadId) ?? null,
          hint: "Hub returned no-such-instance. Expected if the thread already exited cleanly; if the underlying codex/claude CLI is still in `ps`, the kill path leaked (Meridian kill did not wait for process exit)."
        });
        continue;
      }
      log?.warn?.("Settle-time thread cleanup failed", {
        dispatchPlanPath: config.dispatch_plan_path,
        threadId,
        workerId: threadIdToWorkerId.get(threadId) ?? null,
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
    // Forgotten-worker recovery: an `abandoned` judgment can be wrong when the
    // codex CLI survived a kill that did not propagate, or when the hub
    // registry dropped the thread while the worker was still writing. If the
    // expected_output file has fresh mtime > worker.last_seen_at, the worker
    // accomplished the task after we wrote it off — keep the dispatcher role
    // out of the terminal-settled set so the watchdog re-includes the plan,
    // runs reconcile, and lets `thread_missing:outputs_present` advance the
    // worker to `completed`/`awaiting_validation` instead of leaving the
    // entire dispatcher permanently stuck.
    if (
      worker.status === "abandoned"
      && hasFreshExpectedOutputsAfterLastSeen(worker)
    ) {
      return null;
    }
    return "failed";
  }

  return null;
}

function hasFreshExpectedOutputsAfterLastSeen(worker: DispatchWorkerState): boolean {
  if (!worker.expected_outputs || worker.expected_outputs.length === 0) {
    return false;
  }
  const latestMtimeMs = findMostRecentOutputArtifactMtimeMs(worker.expected_outputs, worker.started_at);
  if (latestMtimeMs <= 0) {
    return false;
  }
  const referenceMs = (() => {
    const lastSeenMs = worker.last_seen_at ? Date.parse(worker.last_seen_at) : NaN;
    if (!Number.isNaN(lastSeenMs)) {
      return lastSeenMs;
    }
    const startedMs = worker.started_at ? Date.parse(worker.started_at) : NaN;
    return Number.isNaN(startedMs) ? 0 : startedMs;
  })();
  return latestMtimeMs > referenceMs;
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

  const worker = lifecycleState.workers[row.worker_id];

  // Lifecycle wins: when `worker.status === "completed"` the lifecycle store
  // has authoritatively recorded the row as done. Force-complete operator
  // overrides — `meridian-tool update-status --status completed`,
  // `resume-worker --action force-complete`, and PM resolver
  // `pm_action: force_complete` — all reach this state WITHOUT producing a
  // numeric `validation.last_score`. Re-litigating validator policy here
  // pins the entire dispatcher role at `active` even when every plan row is
  // ✅ and every lifecycle worker is `completed` (observed on
  // agent-dispatcher-8eb13a31 V-01-A on 2026-05-14: one force-completed row
  // kept the role active indefinitely after all 14 rows were terminal). The
  // settle predicate must trust an authoritative `completed` lifecycle state
  // the same way it already trusts `skipped`.
  if (worker?.status === "completed") {
    return true;
  }

  const score = worker?.validation?.last_score;
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
