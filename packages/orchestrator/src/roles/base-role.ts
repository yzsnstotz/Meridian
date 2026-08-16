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

  /**
   * Optional opt-in: returns true if this role issued the outbound message
   * whose response carries the given trace_id, so RoleRunner.dispatch can
   * route an inbound HubResult by trace_id when the result.thread_id does
   * not directly match a registered role thread.
   *
   * This is the contract-level mechanism roles use when they expect a
   * response whose result.thread_id is NOT their own (e.g. the response to
   * intent:"spawn" arrives with result.thread_id set to the NEW agent
   * thread, not the calling role's threadId).
   *
   * Default behavior (when not implemented): false — the role does not
   * accept inbound traffic by trace_id, only by direct thread_id match.
   */
  claimsTrace?(traceId: string): boolean;
}
