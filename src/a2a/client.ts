import { randomUUID } from "node:crypto";
import net from "node:net";

import { HUB_SOCKET_PATH, ROLES_SERVICE_ID, ROLES_SOCKET_PATH } from "../config";
import type { Logger } from "../roles/base-role";
import {
  AgentInstanceSchema,
  HubResultSchema,
  ReplyChannelSchema,
  type AgentInstance,
  type HubMessage,
  type HubResult,
  type ReplyChannel
} from "../types";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;

interface AgentCard {
  name: string;
  url: string;
  skills: Array<{
    id: string;
    intents: string[];
  }>;
}

interface RegisterPayload {
  service: string;
  socket_path: string;
  agent_card: AgentCard;
}

export interface A2AClientOptions {
  hubSocketPath?: string;
  hubSocketPaths?: string[];
  rolesSocketPath?: string;
  serviceId?: string;
  log?: Logger;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  retryBaseDelayMs?: number;
  maxRetryDelayMs?: number;
}

export class A2AClient {
  private readonly hubSocketPath: string;
  private readonly hubSocketPaths: string[];
  private readonly rolesSocketPath: string;
  private readonly serviceId: string;
  private readonly serviceName: string;
  private readonly log: Logger;
  private readonly connectTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly queue: Partial<HubMessage>[] = [];

  private running = false;
  private registered = false;
  private registrationPromise: Promise<void> | null = null;
  private flushPromise: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryResolver: (() => void) | null = null;

  constructor(options: A2AClientOptions = {}) {
    this.hubSocketPath = options.hubSocketPath ?? HUB_SOCKET_PATH;
    this.hubSocketPaths = buildHubSocketPathCandidates(this.hubSocketPath, options.hubSocketPaths);
    this.rolesSocketPath = options.rolesSocketPath ?? ROLES_SOCKET_PATH;
    this.serviceId = options.serviceId ?? ROLES_SERVICE_ID;
    this.serviceName = stripServicePrefix(this.serviceId);
    this.log = options.log ?? console;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.ensureRegistered();
    await this.flushQueue();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.registered = false;
    this.clearRetryWait();
  }

  async send(message: Partial<HubMessage>): Promise<void> {
    this.queue.push(message);

    if (!this.running) {
      return;
    }

    if (!this.registered) {
      void this.ensureRegistered()
        .then(() => this.flushQueue())
        .catch((error) => {
          if (isStoppedRegistrationError(error)) {
            return;
          }
          this.log.warn("A2A registration retry failed", asError(error));
        });
      return;
    }

    void this.flushQueue();
  }

  async listInstances(): Promise<AgentInstance[]> {
    if (!this.running) {
      throw new Error("A2A client has not been started");
    }

    await this.ensureRegistered();
    const result = await this.sendRequest(this.buildListInstancesMessage());
    if (result.status !== "success") {
      throw new Error(`list failed: ${result.content}`);
    }

    try {
      return AgentInstanceSchema.array().parse(JSON.parse(result.content));
    } catch (error) {
      throw new Error(`list failed: invalid AgentInstance[] response: ${asError(error).message}`);
    }
  }

  async listReplyChannels(): Promise<ReplyChannel[]> {
    if (!this.running) {
      throw new Error("A2A client has not been started");
    }

    await this.ensureRegistered();
    const result = await this.sendRequest(this.buildListReplyChannelsMessage());
    if (result.status !== "success") {
      throw new Error(`list reply channels failed: ${result.content}`);
    }

    try {
      return parseReplyChannels(result.content);
    } catch (error) {
      throw new Error(`list reply channels failed: invalid ReplyChannel[] response: ${asError(error).message}`);
    }
  }

  async getThreadDetail(threadId: string, traceId?: string): Promise<HubResult> {
    if (!this.running) {
      throw new Error("A2A client has not been started");
    }

    await this.ensureRegistered();
    const result = await this.sendRequest(this.buildDetailMessage(threadId, traceId));
    if (result.status !== "success") {
      throw new Error(`detail failed: ${result.content}`);
    }

    return result;
  }

  private async ensureRegistered(): Promise<void> {
    if (this.registered) {
      return;
    }

    if (this.registrationPromise) {
      return this.registrationPromise;
    }

    this.registrationPromise = this.registerWithRetry().finally(() => {
      this.registrationPromise = null;
    });

    return this.registrationPromise;
  }

  private async registerWithRetry(): Promise<void> {
    let delayMs = this.retryBaseDelayMs;

    while (this.running) {
      try {
        const result = await this.sendRequest(this.buildRegisterMessage());
        if (result.status !== "success") {
          throw new Error(`register_service failed: ${result.content}`);
        }

        this.registered = true;
        this.log.info("A2A client registered meridian-roles", {
          service: this.serviceName,
          socketPath: this.rolesSocketPath
        });
        return;
      } catch (error) {
        this.registered = false;
        if (!this.running) {
          break;
        }

        this.log.warn("A2A client registration failed; retrying", {
          service: this.serviceName,
          hubSocketPath: this.hubSocketPath,
          retryDelayMs: delayMs,
          error: asError(error).message
        });

        await this.waitForRetry(delayMs);
        delayMs = Math.min(delayMs * 2, this.maxRetryDelayMs);
      }
    }

    throw new Error("A2A client stopped before register_service completed");
  }

  private async flushQueue(): Promise<void> {
    if (!this.running || !this.registered || this.queue.length === 0) {
      return;
    }

    if (this.flushPromise) {
      return this.flushPromise;
    }

    this.flushPromise = (async () => {
      while (this.running && this.registered && this.queue.length > 0) {
        const nextMessage = this.queue[0];

        try {
          await this.sendFireAndForget(nextMessage);
          this.queue.shift();
        } catch (error) {
          this.registered = false;
          this.log.warn("A2A send failed; re-registering before retry", {
            hubSocketPath: this.hubSocketPath,
            error: asError(error).message
          });

          if (this.running) {
            void this.ensureRegistered()
              .then(() => this.flushQueue())
              .catch((registrationError) => {
                if (isStoppedRegistrationError(registrationError)) {
                  return;
                }
                this.log.warn("A2A background registration failed", asError(registrationError));
              });
          }
          return;
        }
      }
    })().finally(() => {
      this.flushPromise = null;
    });

    return this.flushPromise;
  }

  private buildRegisterMessage(): HubMessage {
    const payload: RegisterPayload = {
      service: this.serviceName,
      socket_path: this.rolesSocketPath,
      agent_card: {
        name: this.serviceName,
        url: this.rolesSocketPath,
        skills: [
          {
            id: "role-coordination",
            intents: []
          }
        ]
      }
    };

    return {
      trace_id: randomUUID(),
      thread_id: "register",
      actor_id: this.serviceName,
      intent: "register_service",
      target: "global",
      priority: 5,
      mode: "bridge",
      reply_channel: this.buildServiceReplyChannel(),
      payload: {
        content: JSON.stringify(payload),
        attachments: []
      }
    };
  }

  private buildListInstancesMessage(): HubMessage {
    return {
      trace_id: randomUUID(),
      thread_id: "list_instances",
      actor_id: this.serviceId,
      intent: "list",
      target: "global",
      priority: 5,
      mode: "bridge",
      reply_channel: this.buildServiceReplyChannel(),
      payload: {
        content: "",
        attachments: []
      }
    };
  }

  private buildListReplyChannelsMessage(): HubMessage {
    return {
      trace_id: randomUUID(),
      thread_id: "list_reply_channels",
      actor_id: this.serviceId,
      intent: "list",
      target: "global",
      priority: 5,
      mode: "bridge",
      reply_channel: this.buildServiceReplyChannel(),
      payload: {
        content: JSON.stringify({ kind: "reply_channels" }),
        attachments: []
      }
    };
  }

  private buildDetailMessage(threadId: string, traceId?: string): HubMessage {
    return {
      trace_id: randomUUID(),
      thread_id: threadId,
      actor_id: this.serviceId,
      intent: "detail",
      target: threadId,
      priority: 5,
      mode: "bridge",
      reply_channel: this.buildServiceReplyChannel(),
      payload: {
        content: traceId ?? "",
        attachments: []
      }
    };
  }

  private buildServiceReplyChannel(): HubMessage["reply_channel"] {
    return {
      channel: "web",
      chat_id: this.serviceId
    };
  }

  private sendFireAndForget(message: Partial<HubMessage>): Promise<void> {
    return this.withHubSocketFallback((socketPath) => new Promise((resolve, reject) => {
      let settled = false;
      const socket = net.createConnection(socketPath);
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        socket.destroy(new Error(`A2A send connect timed out after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);

      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        reject(asError(error));
      };

      socket.once("connect", () => {
        if (settled) {
          return;
        }

        clearTimeout(timeout);

        try {
          socket.end(JSON.stringify(message));
          settled = true;
          resolve();
        } catch (error) {
          fail(error);
        }
      });

      socket.once("error", fail);
    }));
  }

  private sendRequest(message: HubMessage): Promise<HubResult> {
    return this.withHubSocketFallback((socketPath) => new Promise((resolve, reject) => {
      let settled = false;
      let rawResponse = "";
      const socket = net.createConnection(socketPath);
      const connectTimeout = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        socket.destroy(new Error(`A2A request connect timed out after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);

      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(connectTimeout);
        socket.destroy();
        reject(asError(error));
      };

      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        rawResponse += chunk;
      });
      socket.once("connect", () => {
        if (settled) {
          return;
        }

        clearTimeout(connectTimeout);
        socket.setTimeout(this.responseTimeoutMs);

        try {
          socket.write(JSON.stringify(message));
          socket.end();
        } catch (error) {
          fail(error);
        }
      });
      socket.once("timeout", () => {
        fail(new Error(`A2A request timed out after ${this.responseTimeoutMs}ms`));
      });
      socket.once("error", fail);
      socket.once("close", () => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(connectTimeout);

        if (!rawResponse.trim()) {
          reject(new Error("A2A request completed without a response body"));
          return;
        }

        try {
          resolve(HubResultSchema.parse(JSON.parse(rawResponse)));
        } catch (error) {
          reject(asError(error));
        }
      });
    }));
  }

  private async withHubSocketFallback<T>(attempt: (socketPath: string) => Promise<T>): Promise<T> {
    let lastError: Error | null = null;

    for (let index = 0; index < this.hubSocketPaths.length; index += 1) {
      const socketPath = this.hubSocketPaths[index];
      try {
        return await attempt(socketPath);
      } catch (error) {
        const normalizedError = asError(error);
        lastError = normalizedError;

        if (index === this.hubSocketPaths.length - 1 || !isHubSocketRetryableError(normalizedError)) {
          throw normalizedError;
        }
      }
    }

    throw lastError ?? new Error("No hub socket candidates configured");
  }

  private waitForRetry(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.clearRetryWait();
      this.retryResolver = () => {
        this.retryResolver = null;
        this.retryTimer = null;
        resolve();
      };
      this.retryTimer = setTimeout(() => {
        const finish = this.retryResolver;
        this.retryResolver = null;
        this.retryTimer = null;
        finish?.();
      }, delayMs);
    });
  }

  private clearRetryWait(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    const resolver = this.retryResolver;
    this.retryResolver = null;
    resolver?.();
  }
}

function stripServicePrefix(serviceId: string): string {
  return serviceId.replace(/^service:/, "");
}

function buildHubSocketPathCandidates(primaryPath: string, explicitPaths?: string[]): string[] {
  if (explicitPaths && explicitPaths.length > 0) {
    return dedupeSocketPaths(explicitPaths);
  }

  return dedupeSocketPaths([primaryPath]);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function dedupeSocketPaths(paths: string[]): string[] {
  const normalized = paths
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return [...new Set(normalized)];
}

function parseReplyChannels(rawContent: string): ReplyChannel[] {
  const parsed = JSON.parse(rawContent) as unknown;
  const candidate = typeof parsed === "object" && parsed !== null && "channels" in parsed
    ? (parsed as { channels?: unknown }).channels
    : parsed;

  return ReplyChannelSchema.array().parse(candidate);
}

function isStoppedRegistrationError(error: unknown): boolean {
  return asError(error).message === "A2A client stopped before register_service completed";
}

function isHubSocketRetryableError(error: Error): boolean {
  const errorWithCode = error as NodeJS.ErrnoException;
  if (errorWithCode.code === "ENOENT" || errorWithCode.code === "ECONNREFUSED" || errorWithCode.code === "ENOTSOCK") {
    return true;
  }

  return /A2A (?:send|request) connect timed out after/i.test(error.message);
}
