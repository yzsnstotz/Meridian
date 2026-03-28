import type { StateStore } from "../../state-store";
import { DispatcherConfigSchema, type DispatcherConfig, type HubResult } from "../../types";
import type { BaseRole, RoleContext } from "../base-role";

type PersistableStateStore = Pick<StateStore, "load" | "save">;

export interface AgentDispatcherRoleOptions {
  stateStore?: PersistableStateStore;
}

export class AgentDispatcherRole implements BaseRole {
  readonly roleType = "agent-dispatcher" as const;
  readonly threadId: string;
  readonly config: DispatcherConfig;

  constructor(threadId: string, config: unknown, options: AgentDispatcherRoleOptions = {}) {
    this.threadId = threadId;
    this.config = DispatcherConfigSchema.parse(config);
    void options.stateStore;
  }

  async onActivate(_ctx: RoleContext): Promise<void> {
    return undefined;
  }

  async onDeactivate(): Promise<void> {
    return undefined;
  }

  async onInboundResult(_result: HubResult): Promise<void> {
    return undefined;
  }

  async onStatusChange(_threadId: string, _status: string): Promise<void> {
    return undefined;
  }
}
