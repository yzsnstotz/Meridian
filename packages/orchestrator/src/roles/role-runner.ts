import path from "node:path";

import { DispatcherLaunchBreaker, LaunchBreakerTrippedError } from "./agent-dispatcher/launch-breaker";
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
  // Per-role launch-rate budget. Injectable so tests can use a tighter
  // threshold; defaults to 3 launches per 60s, which production runs
  // should never approach.
  launchBreaker?: DispatcherLaunchBreaker;
  // Called when a launch is rejected by the breaker. Wiring in src/index.ts
  // uses this to force the role to PAUSED in the state-store so the GUI
  // reflects reality instead of looping the user back through reactivation.
  onLaunchBreakerTripped?: (dispatcherRoleId: string, error: LaunchBreakerTrippedError) => Promise<void>;
}

export interface RehydrationContext {
  needsReactivation: boolean;
}

const defaultLogger: Logger = console;

export class RoleRunner {
  private readonly roles = new Map<string, BaseRole>();
  private readonly context: RoleContext;
  private readonly launchBreaker: DispatcherLaunchBreaker;
  private readonly onLaunchBreakerTripped: ((roleId: string, err: LaunchBreakerTrippedError) => Promise<void>) | null;
  private readonly log: Logger;

  constructor(options: RoleRunnerOptions) {
    this.log = options.log ?? defaultLogger;
    this.context = {
      sendToHub: options.sendToHub,
      listInstances: () => options.listInstances?.() ?? [],
      log: this.log
    };
    this.launchBreaker = options.launchBreaker ?? new DispatcherLaunchBreaker();
    this.onLaunchBreakerTripped = options.onLaunchBreakerTripped ?? null;
  }

  async activate(role: BaseRole, rehydrationContext?: RehydrationContext): Promise<void> {
    if (this.roles.has(role.threadId)) {
      throw new Error(`Role already active for thread ${role.threadId}`);
    }

    // Launch-rate gate (agent-dispatcher only). Catches the failure mode where
    // an HTTP client (GUI auto-refresh / external) hammers continue-dispatcher
    // while the Hub is overloaded — each request used to spawn a fresh codex
    // thread, none of which could complete. Scheduler launches don't drive
    // codex spawns directly so they bypass.
    if (role.roleType === "agent-dispatcher") {
      const verdict = this.launchBreaker.shouldAllow(role.threadId, Date.now());
      if (!verdict.allowed) {
        const tripError = new LaunchBreakerTrippedError(role.threadId, verdict);
        this.log.error("RoleRunner: launch breaker tripped, aborting activate", {
          dispatcherRoleId: role.threadId,
          countAfter: verdict.countAfter,
          windowStartedAt: new Date(verdict.windowStartedAt).toISOString()
        });
        if (this.onLaunchBreakerTripped) {
          await this.onLaunchBreakerTripped(role.threadId, tripError).catch((e) => {
            this.log.warn("RoleRunner: onLaunchBreakerTripped callback failed", {
              dispatcherRoleId: role.threadId,
              error: e instanceof Error ? e.message : String(e)
            });
          });
        }
        throw tripError;
      }
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

  /**
   * Clears the launch-rate budget for a dispatcher. Wired into resume so an
   * operator who fixed the underlying issue (Hub recovered, etc.) gets a
   * fresh budget without restarting meridian-roles.
   */
  resetLaunchBreaker(dispatcherRoleId: string): void {
    this.launchBreaker.reset(dispatcherRoleId);
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
    // Resume = operator has investigated. Give the launch budget a clean slate
    // so a legitimate retry isn't rejected by leftover budget from the last
    // thrash.
    this.launchBreaker.reset(threadId);
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

    // Same gate as activate(): relaunchHubSession spawns a fresh codex
    // dispatcher thread. Counts against the launch budget.
    const verdict = this.launchBreaker.shouldAllow(threadId, Date.now());
    if (!verdict.allowed) {
      const tripError = new LaunchBreakerTrippedError(threadId, verdict);
      this.log.error("RoleRunner: launch breaker tripped, aborting relaunch", {
        dispatcherRoleId: threadId,
        countAfter: verdict.countAfter
      });
      if (this.onLaunchBreakerTripped) {
        await this.onLaunchBreakerTripped(threadId, tripError).catch((e) => {
          this.log.warn("RoleRunner: onLaunchBreakerTripped callback failed", {
            dispatcherRoleId: threadId,
            error: e instanceof Error ? e.message : String(e)
          });
        });
      }
      throw tripError;
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
    // First pass: ask each role via the opt-in claimsTrace contract. This is
    // the generic mechanism roles use when their outbound expects a response
    // whose result.thread_id does not match the role's own thread_id (e.g.
    // chatter's intent:"spawn" returns the NEW agent thread_id).
    for (const candidate of this.roles.values()) {
      if (typeof candidate.claimsTrace === "function" && candidate.claimsTrace(result.trace_id)) {
        return candidate;
      }
    }

    // Back-compat: agent-dispatcher kept its pre-claimsTrace introspection
    // path so existing roles continue to receive infer-mode and task-row
    // traces. New roles SHOULD implement claimsTrace instead of relying on
    // this branch.
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
