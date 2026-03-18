import type { AgentInstance, HubMessage, HubResult } from "../types";
import type { BaseRole, Logger, RoleContext } from "./base-role";

export interface RoleRunnerOptions {
  sendToHub(msg: Partial<HubMessage>): Promise<void>;
  listInstances?: () => AgentInstance[];
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
    const role = this.roles.get(result.thread_id);
    if (!role) {
      this.context.log.debug("Ignoring inbound result for unknown role thread", {
        threadId: result.thread_id,
        traceId: result.trace_id
      });
      return;
    }

    await role.onInboundResult(result);
  }
}
