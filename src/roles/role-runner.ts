import path from "node:path";

import { LifecycleStore } from "./agent-dispatcher/lifecycle-store";
import { SessionManager } from "./agent-dispatcher/session-manager";
import type { AgentInstance, HubMessage, HubResult } from "../types";
import { AgentDispatcherConfigSchema } from "../types";
import { StateStore } from "../state-store";
import type { Awaitable, BaseRole, Logger, RoleContext } from "./base-role";
import { AgentDispatcherRole } from "./definitions/agent-dispatcher";

const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";

export interface RoleRunnerOptions {
  sendToHub(msg: Partial<HubMessage>): Promise<void>;
  listInstances?: () => Awaitable<AgentInstance[]>;
  log?: Logger;
}

export interface RehydrationContext {
  needsReactivation: boolean;
}

const defaultLogger: Logger = console;

export class RoleRunner {
  private readonly roles = new Map<string, BaseRole>();
  private readonly context: RoleContext;

  constructor(options: RoleRunnerOptions) {
    this.context = {
      sendToHub: options.sendToHub,
      listInstances: () => options.listInstances?.() ?? [],
      log: options.log ?? defaultLogger
    };
  }

  async activate(role: BaseRole, rehydrationContext?: RehydrationContext): Promise<void> {
    if (this.roles.has(role.threadId)) {
      throw new Error(`Role already active for thread ${role.threadId}`);
    }

    this.roles.set(role.threadId, role);

    try {
      // Scheduler handles its own state recovery; skip dispatcher-specific rehydration
      if (role.roleType !== "scheduler") {
        if (rehydrationContext?.needsReactivation) {
          await restartRehydratedAgentDispatcher(role);
        } else if (rehydrationContext && await tryResumeRehydratedAgentDispatcher(role, this.context)) {
          return;
        }
      }

      await role.onActivate(this.context);
    } catch (error) {
      this.roles.delete(role.threadId);
      throw error;
    }
  }

  async deactivate(threadId: string): Promise<void> {
    const role = this.roles.get(threadId);
    if (!role) {
      return;
    }

    await role.onDeactivate();
    this.roles.delete(threadId);
  }

  getRole(threadId: string): BaseRole | null {
    return this.roles.get(threadId) ?? null;
  }

  listRoles(): BaseRole[] {
    return [...this.roles.values()];
  }

  async pauseRole(threadId: string): Promise<boolean> {
    return this.updateRoleStatus(threadId, "paused");
  }

  async resumeRole(threadId: string): Promise<boolean> {
    return this.updateRoleStatus(threadId, "active");
  }

  async relaunchAgentDispatcherHub(threadId: string): Promise<{ dispatcher_thread_id: string }> {
    const role = this.roles.get(threadId);
    if (!role || role.roleType !== "agent-dispatcher") {
      throw new Error(`Agent dispatcher not active for thread ${threadId}`);
    }

    if (!(role instanceof AgentDispatcherRole)) {
      throw new Error(`Role ${threadId} is not an AgentDispatcherRole instance`);
    }

    return role.relaunchHubSession();
  }

  async dispatch(result: HubResult): Promise<void> {
    let role = this.roles.get(result.thread_id);
    if (!role) {
      // Hub `run` results often carry the agent thread_id (codex_01), while the outbound
      // HubMessage.thread_id was the dispatcher role. Fall back to trace_id correlation.
      role = this.findRoleByInboundTrace(result);
    }
    if (!role) {
      this.context.log.debug("Ignoring inbound result for unknown role thread", {
        threadId: result.thread_id,
        traceId: result.trace_id
      });
      return;
    }

    await role.onInboundResult(result);
  }

  private findRoleByInboundTrace(result: HubResult): BaseRole | undefined {
    for (const candidate of this.roles.values()) {
      if (candidate.roleType !== "agent-dispatcher") {
        continue;
      }

      const inferTraceId = (candidate as { inferTraceId?: string | null }).inferTraceId;
      if (inferTraceId === result.trace_id) {
        return candidate;
      }

      const tasks = (candidate.config as { tasks?: Array<{ result_trace_id?: string }> }).tasks;
      if (tasks?.some((task) => task.result_trace_id === result.trace_id)) {
        return candidate;
      }
    }
    return undefined;
  }

  private async updateRoleStatus(threadId: string, status: string): Promise<boolean> {
    const role = this.roles.get(threadId);
    if (!role) {
      return false;
    }

    await role.onStatusChange(threadId, status);
    return true;
  }
}

type AgentDispatcherRoleInternals = {
  ctx: RoleContext | null;
  sessionManager: SessionManager | null;
  stateStore?: Pick<StateStore, "load" | "save">;
};

type SessionManagerInternals = {
  dispatcherThreadId: string | null;
  pauseStateReady: Promise<void>;
};

async function restartRehydratedAgentDispatcher(role: BaseRole): Promise<void> {
  const config = parseAgentDispatcherConfig(role);
  if (!config) {
    return;
  }

  const sessionManager = createRehydrationSessionManager(role, config.dispatch_plan_path);
  await sessionManager.onRestart();
}

async function tryResumeRehydratedAgentDispatcher(role: BaseRole, context: RoleContext): Promise<boolean> {
  const config = parseAgentDispatcherConfig(role);
  if (!config) {
    return false;
  }

  const lifecycleState = new LifecycleStore(resolveDispatchThreadPath(config.dispatch_plan_path)).load();
  const dispatcherThreadId = lifecycleState.dispatcher.status === "running"
    ? lifecycleState.dispatcher.thread_id
    : null;
  if (!dispatcherThreadId) {
    return false;
  }

  const sessionManager = createRehydrationSessionManager(role, config.dispatch_plan_path);
  const sessionManagerInternals = sessionManager as unknown as SessionManagerInternals;
  await sessionManagerInternals.pauseStateReady;
  sessionManagerInternals.dispatcherThreadId = dispatcherThreadId;

  const roleInternals = role as unknown as AgentDispatcherRoleInternals;
  roleInternals.ctx = context;
  roleInternals.sessionManager = sessionManager;

  return true;
}

function createRehydrationSessionManager(role: BaseRole, dispatchPlanPath: string): SessionManager {
  const roleInternals = role as unknown as AgentDispatcherRoleInternals;
  return new SessionManager(role.threadId, {
    dispatchPlanPath,
    stateStore: roleInternals.stateStore ?? new StateStore()
  });
}

function parseAgentDispatcherConfig(role: BaseRole) {
  if (role.roleType !== "agent-dispatcher") {
    return null;
  }

  const parsed = AgentDispatcherConfigSchema.safeParse(role.config);
  return parsed.success ? parsed.data : null;
}

function resolveDispatchThreadPath(dispatchPlanPath: string): string {
  return path.join(path.dirname(dispatchPlanPath), DISPATCH_THREADS_FILENAME);
}
