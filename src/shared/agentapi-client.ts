import http from "node:http";
import { Readable } from "node:stream";
import { EventSource } from "eventsource";

import { createLogger } from "../logger";
import type { FileAttachment } from "../types";

type HttpMethod = "GET" | "POST";

export interface AgentStatus {
  status: string;
  thread_id?: string;
  [key: string]: unknown;
}

export interface AgentEvent {
  type: string;
  thread_id: string;
  data: unknown;
  raw: string;
}

export type AgentMessageResponse = Record<string, unknown>;

export interface AgentEventSubscription {
  close: () => void;
}

export interface EventSourceLike {
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  close: () => void;
}

interface EventSourceFactoryInit {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export type EventSourceFactory = (url: string, init: EventSourceFactoryInit) => EventSourceLike;

interface MonitorLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface SseReconnectAttemptContext {
  threadId: string;
  socketPath: string;
  attempt: number;
  delayMs: number;
  errorSummary: string;
}

export interface SseReconnectExhaustedContext {
  threadId: string;
  socketPath: string;
  attempts: number;
  errorSummary: string;
}

export interface AgentAPIClientOptions {
  threadId?: string;
  maxReconnectAttempts?: number;
  baseReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  eventSourceFactory?: EventSourceFactory;
  monitorLogger?: MonitorLogger;
  onSseReconnectAttempt?: (context: SseReconnectAttemptContext) => void;
  onSseReconnectExhausted?: (context: SseReconnectExhaustedContext) => void;
}

interface HttpResponse {
  statusCode: number;
  body: string;
  headers: Headers;
}

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_BASE_RECONNECT_DELAY_MS = 500;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 10_000;
const EVENTS_URL = "http://agentapi/events";

export class AgentAPIClient {
  private socketPath: string | null = null;
  private threadId: string;
  private sseClient: EventSourceLike | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly maxReconnectAttempts: number;
  private readonly baseReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly eventSourceFactory: EventSourceFactory;
  private readonly monitorLogger: MonitorLogger;
  private readonly onSseReconnectAttempt?: (context: SseReconnectAttemptContext) => void;
  private readonly onSseReconnectExhausted?: (context: SseReconnectExhaustedContext) => void;
  private manualClose = false;
  private reconnectAttempts = 0;

  constructor(options: AgentAPIClientOptions = {}) {
    this.threadId = options.threadId ?? "unknown";
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.baseReconnectDelayMs = options.baseReconnectDelayMs ?? DEFAULT_BASE_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    this.eventSourceFactory =
      options.eventSourceFactory ??
      ((url: string, init: EventSourceFactoryInit) => new EventSource(url, init));
    this.monitorLogger =
      options.monitorLogger ?? createLogger("monitor", { thread_id: this.threadId, trace_id: null });
    this.onSseReconnectAttempt = options.onSseReconnectAttempt;
    this.onSseReconnectExhausted = options.onSseReconnectExhausted;
  }

  async connect(socketPath: string): Promise<void> {
    this.socketPath = socketPath;
    this.manualClose = false;

    try {
      await this.getStatus();
    } catch (error) {
      this.socketPath = null;
      throw this.withContext("Failed to connect to agentapi", error, socketPath);
    }
  }

  setThreadId(threadId: string): void {
    this.threadId = threadId;
  }

  async sendMessage(content: string, attachments: FileAttachment[] = []): Promise<AgentMessageResponse> {
    const response = await this.requestJson("/message", "POST", {
      content,
      attachments
    });

    if (response && typeof response === "object") {
      return response as AgentMessageResponse;
    }

    throw this.withContext("POST /message returned invalid payload", new Error("response is not a JSON object"));
  }

  async getStatus(): Promise<AgentStatus> {
    const response = await this.requestJson("/status", "GET");

    if (!response || typeof response !== "object") {
      throw this.withContext("GET /status returned invalid payload", new Error("response is not a JSON object"));
    }

    const statusCandidate = response as Record<string, unknown>;
    if (typeof statusCandidate.status !== "string") {
      throw this.withContext(
        "GET /status returned invalid payload",
        new Error("response.status must be a string")
      );
    }

    return statusCandidate as AgentStatus;
  }

  subscribeEvents(handler: (event: AgentEvent) => void): AgentEventSubscription {
    const socketPath = this.requireSocketPath();
    this.manualClose = false;
    this.reconnectAttempts = 0;
    this.clearSseConnection();

    const connectStream = (): void => {
      if (this.manualClose) {
        return;
      }

      const sseClient = this.eventSourceFactory(EVENTS_URL, {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          this.fetchOverUnixSocket(socketPath, input, init)
      });

      this.sseClient = sseClient;

      sseClient.addEventListener("open", () => {
        this.reconnectAttempts = 0;
      });

      sseClient.addEventListener("message", (eventPayload: unknown) => {
        const event = this.normalizeEventPayload(eventPayload);
        handler({
          type: event.type,
          thread_id: this.threadId,
          data: event.data,
          raw: event.raw
        });
      });

      sseClient.addEventListener("error", (eventPayload: unknown) => {
        if (this.manualClose) {
          return;
        }

        sseClient.close();
        if (this.sseClient === sseClient) {
          this.sseClient = null;
        }

        this.scheduleReconnect(eventPayload, socketPath, connectStream);
      });
    };

    connectStream();

    return {
      close: () => {
        this.manualClose = true;
        this.clearSseConnection();
      }
    };
  }

  disconnect(): void {
    this.manualClose = true;
    this.clearSseConnection();
    this.socketPath = null;
    this.reconnectAttempts = 0;
  }

  private clearSseConnection(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.sseClient) {
      this.sseClient.close();
      this.sseClient = null;
    }
  }

  private scheduleReconnect(eventPayload: unknown, socketPath: string, reconnect: () => void): void {
    const errorSummary = this.extractErrorSummary(eventPayload);

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.monitorLogger.error(
        {
          event_type: "agentapi_sse_reconnect_exhausted",
          reconnect_attempts: this.reconnectAttempts,
          thread_id: this.threadId,
          socket_path: socketPath,
          error: errorSummary
        },
        "AgentAPI SSE reconnect attempts exhausted"
      );
      if (this.onSseReconnectExhausted) {
        try {
          this.onSseReconnectExhausted({
            threadId: this.threadId,
            socketPath,
            attempts: this.reconnectAttempts,
            errorSummary
          });
        } catch {
          this.monitorLogger.debug(
            { thread_id: this.threadId, socket_path: socketPath },
            "Ignored onSseReconnectExhausted callback failure"
          );
        }
      }
      return;
    }

    this.reconnectAttempts += 1;
    const delay = Math.min(
      this.baseReconnectDelayMs * 2 ** (this.reconnectAttempts - 1),
      this.maxReconnectDelayMs
    );

    this.monitorLogger.warn(
      {
        event_type: "agentapi_sse_reconnect",
        reconnect_attempt: this.reconnectAttempts,
        reconnect_delay_ms: delay,
        thread_id: this.threadId,
        socket_path: socketPath,
        error: errorSummary
      },
      "AgentAPI SSE stream disconnected, scheduling reconnect"
    );
    if (this.onSseReconnectAttempt) {
      try {
        this.onSseReconnectAttempt({
          threadId: this.threadId,
          socketPath,
          attempt: this.reconnectAttempts,
          delayMs: delay,
          errorSummary
        });
      } catch {
        this.monitorLogger.debug(
          { thread_id: this.threadId, socket_path: socketPath },
          "Ignored onSseReconnectAttempt callback failure"
        );
      }
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      reconnect();
    }, delay);
  }

  private normalizeEventPayload(eventPayload: unknown): { type: string; data: unknown; raw: string } {
    const payload = eventPayload as { data?: unknown; type?: unknown };
    const raw = typeof payload?.data === "string" ? payload.data : "";
    const parsed = this.parseJsonOrFallback(raw);
    const type = typeof payload?.type === "string" ? payload.type : "message";
    return { type, data: parsed, raw };
  }

  private parseJsonOrFallback(raw: string): unknown {
    if (!raw) {
      return raw;
    }

    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }

  private async requestJson(path: string, method: HttpMethod, payload?: unknown): Promise<unknown> {
    const socketPath = this.requireSocketPath();
    const body = payload === undefined ? undefined : JSON.stringify(payload);

    try {
      const response = await this.request(socketPath, path, method, body);

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`HTTP ${response.statusCode} returned for ${method} ${path}`);
      }

      if (!response.body.trim()) {
        return {};
      }

      return JSON.parse(response.body) as unknown;
    } catch (error) {
      throw this.withContext(`Failed to call ${method} ${path}`, error, socketPath);
    }
  }

  private request(
    socketPath: string,
    path: string,
    method: HttpMethod,
    body?: string
  ): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve, reject) => {
      const headers: Record<string, string> = {
        Accept: "application/json"
      };

      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = String(Buffer.byteLength(body));
      }

      const request = http.request(
        {
          socketPath,
          method,
          path,
          headers
        },
        (response) => {
          let responseBody = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            responseBody += chunk;
          });
          response.on("end", () => {
            resolve({
              statusCode: response.statusCode ?? 500,
              body: responseBody,
              headers: this.toHeaders(response.headers)
            });
          });
        }
      );

      request.on("error", reject);
      if (body !== undefined) {
        request.write(body);
      }
      request.end();
    });
  }

  private async fetchOverUnixSocket(
    socketPath: string,
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const url = this.resolveUrl(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = this.normalizeHeaders(init?.headers);

    if (method !== "GET") {
      throw this.withContext(
        "SSE fetch over unix socket only supports GET",
        new Error(`received method ${method}`),
        socketPath
      );
    }

    return await new Promise<Response>((resolve, reject) => {
      const request = http.request(
        {
          socketPath,
          method,
          path: `${url.pathname}${url.search}`,
          headers
        },
        (response) => {
          const stream = Readable.toWeb(response) as unknown as ReadableStream;
          resolve(
            new Response(stream, {
              status: response.statusCode ?? 500,
              headers: this.toHeaders(response.headers)
            })
          );
        }
      );

      request.on("error", (error) => {
        reject(this.withContext("Failed to open SSE stream", error, socketPath));
      });
      request.end();
    });
  }

  private resolveUrl(input: RequestInfo | URL): URL {
    if (typeof input === "string") {
      return new URL(input);
    }

    if (input instanceof URL) {
      return input;
    }

    return new URL(input.url);
  }

  private normalizeHeaders(headersInit?: HeadersInit): Record<string, string> {
    const normalized: Record<string, string> = {};
    if (!headersInit) {
      return normalized;
    }

    const headers = new Headers(headersInit);
    for (const [key, value] of headers.entries()) {
      normalized[key] = value;
    }
    return normalized;
  }

  private toHeaders(headers: http.IncomingHttpHeaders): Headers {
    const normalized = new Headers();
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        normalized.set(key, value.join(","));
      } else if (typeof value === "string") {
        normalized.set(key, value);
      }
    }
    return normalized;
  }

  private requireSocketPath(): string {
    if (!this.socketPath) {
      throw this.withContext(
        "AgentAPIClient is not connected",
        new Error("call connect(socketPath) before making requests")
      );
    }

    return this.socketPath;
  }

  private withContext(message: string, error: unknown, socketPathOverride?: string): Error {
    const socketPath = socketPathOverride ?? this.socketPath ?? "unconnected";
    const reason = error instanceof Error ? error.message : String(error);
    return new Error(`${message} (thread_id=${this.threadId}, socketPath=${socketPath}): ${reason}`);
  }

  private extractErrorSummary(error: unknown): string {
    if (error && typeof error === "object") {
      const candidate = error as { message?: unknown; code?: unknown };
      const code = candidate.code ? ` code=${String(candidate.code)}` : "";
      const message = candidate.message ? ` message=${String(candidate.message)}` : "";
      const summary = `${code}${message}`.trim();
      if (summary) {
        return summary;
      }
    }

    if (typeof error === "string") {
      return error;
    }

    return "unknown error";
  }
}
