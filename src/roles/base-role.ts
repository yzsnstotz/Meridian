import type { AgentInstance, HubMessage, HubResult, RoleType } from "../types";

export type Awaitable<T> = T | Promise<T>;

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface RoleContext {
  sendToHub(msg: Partial<HubMessage>): Promise<void>;
  listInstances(): Awaitable<AgentInstance[]>;
  log: Logger;
}

export interface BaseRole {
  readonly roleType: RoleType;
  readonly threadId: string;
  readonly config: unknown;
  onActivate(ctx: RoleContext): Promise<void>;
  onDeactivate(): Promise<void>;
  onInboundResult(result: HubResult): Promise<void>;
  onStatusChange(threadId: string, status: string): Promise<void>;
}
