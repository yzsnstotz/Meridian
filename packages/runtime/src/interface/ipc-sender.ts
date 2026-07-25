import { config } from "../config";
import { createLogger } from "../logger";
import {
  wrapHubMessage,
  type CallerIdentityWithKey
} from "../shared/caller-wire";
import { sendIpcMessage, sendIpcRequest, IPC_RUN_REQUEST_TIMEOUT_MS } from "../shared/ipc";
import { HubResultSchema, type HubMessage, type HubResult } from "../types";

const interfaceLog = createLogger("interface");

export interface CallerIdentitySetterArgs {
  caller_id: string;
  caller_key: string;
  caller_label: string;
  caller_version?: string;
}

export interface IpcSenderOptions {
  socketPath?: string;
}

export class IpcSender {
  private readonly socketPath: string;
  private identity: CallerIdentityWithKey | null = null;

  constructor(options: IpcSenderOptions = {}) {
    this.socketPath = options.socketPath ?? config.HUB_SOCKET_PATH;
  }

  setCallerIdentity(args: CallerIdentitySetterArgs): void {
    if (!args.caller_id || !args.caller_key || !args.caller_label) {
      throw new Error("caller_identity_required");
    }
    this.identity = {
      caller_id: args.caller_id,
      caller_key: args.caller_key,
      caller_label: args.caller_label,
      ...(args.caller_version ? { caller_version: args.caller_version } : {})
    };
  }

  clearCallerIdentity(): void {
    this.identity = null;
  }

  hasCallerIdentity(): boolean {
    return this.identity !== null;
  }

  getCallerIdentity(): CallerIdentityWithKey | null {
    return this.identity ? { ...this.identity } : null;
  }

  async send(message: HubMessage): Promise<void> {
    const wrapped = this.wrap(message);
    await sendIpcMessage(this.socketPath, wrapped);
    interfaceLog.debug(
      {
        trace_id: message.trace_id,
        thread_id: message.thread_id,
        intent: message.intent,
        target: message.target,
        caller_id: wrapped.auth.caller_id
      },
      "HubMessage forwarded to hub socket"
    );
  }

  async request(message: HubMessage, timeoutMs?: number): Promise<HubResult> {
    const wrapped = this.wrap(message);
    const response = await sendIpcRequest<typeof wrapped, HubResult>(
      this.socketPath,
      wrapped,
      timeoutMs
    );
    return HubResultSchema.parse(response);
  }

  async requestRun(message: HubMessage): Promise<HubResult> {
    return this.request(message, IPC_RUN_REQUEST_TIMEOUT_MS);
  }

  private wrap(message: HubMessage): ReturnType<typeof wrapHubMessage<HubMessage>> {
    if (!this.identity) {
      throw new Error("caller_identity_not_set");
    }
    return wrapHubMessage(message, this.identity);
  }
}

const defaultSender = new IpcSender();

export function setCallerIdentity(args: CallerIdentitySetterArgs): void {
  defaultSender.setCallerIdentity(args);
}

export function clearCallerIdentity(): void {
  defaultSender.clearCallerIdentity();
}

export function hasCallerIdentity(): boolean {
  return defaultSender.hasCallerIdentity();
}

export async function sendHubMessage(message: HubMessage): Promise<void> {
  await defaultSender.send(message);
}

export async function requestHubMessage(
  message: HubMessage,
  timeoutMs?: number
): Promise<HubResult> {
  return defaultSender.request(message, timeoutMs);
}

export async function requestHubRunMessage(message: HubMessage): Promise<HubResult> {
  return defaultSender.requestRun(message);
}
