import type { AgentInstance, HubMessage, HubResult } from "../types";
import type { Awaitable, BaseRole, Logger, RoleContext } from "./base-role";

export interface RoleRunnerOptions {
  sendToHub(msg: Partial<HubMessage>): Promise<void>;
  listInstances?: () => Awaitable<AgentInstance[]>;
  log?: Logger;
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

  async activate(role: BaseRole): Promise<void> {
    if (this.roles.has(role.threadId)) {
      throw new Error(`Role already active for thread ${role.threadId}`);
    }

    this.roles.set(role.threadId, role);

    try {
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
      if (candidate.roleType !== "dispatcher" && candidate.roleType !== "agent-dispatcher") {
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
}
