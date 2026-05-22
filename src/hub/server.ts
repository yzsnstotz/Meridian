import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { config, type AppConfig } from "../config";
import { createLogger } from "../logger";
import type { Logger } from "pino";
import { MonitorEventSchema, type MonitorEvent } from "../monitor/events";
import { BUILTIN_CALLERS, deriveBuiltinCallerKey } from "../shared/caller-bootstrap";
import { unwrapWireFrame, type WireAuth } from "../shared/caller-wire";
import { buildAgentErrorInlineKeyboard } from "../shared/telegram-controls";
import type { A2AMessage } from "../shared/a2a-adapter";
import {
  AgentTypeSchema,
  HubMessageSchema,
  HubResultSchema,
  InboundUIEventSchema,
  ServiceEndpointSchema,
  type ServiceEndpoint,
  type AgentType,
  type HubMessage,
  type HubResult,
  type ReplyChannel,
  type ThreadProgressSnapshot
} from "../types";
import { normalizeInboundEvent } from "./normalizer";
import { appendA2AWebSocketLog } from "./a2a-websocket-log";
import { ResultSender, shouldPushTelegramProactive } from "./result-sender";
import { TelegramChannelAdapter } from "../interface/adapters/telegram-adapter";
import { WebChannelAdapter } from "../interface/adapters/web-adapter";
import { SocketChannelAdapter } from "./socket-adapter";
import { InstanceRegistry } from "./registry";
import type { OutputDelta } from "../shared/stream-adapter";
import { OutputBus } from "./output-bus";
import { HubRouter, type HubRouterOptions, type MonitorUpdateDispatch, type PushDeliveryTarget } from "./router";
import { CredentialStore, discoverHostDefaultsFromHome } from "./credential-store";
import { OAuthLoginJobRegistry } from "./oauth-login-registry";
import { loadPersistedHubState, type CredentialRecord } from "./state-store";

interface InboundEnvelope {
  chatId?: string;
  chat_id?: string;
  event: unknown;
}

export const BOOTSTRAP_KEY_ENV_VAR = "MERIDIAN_INTERNAL_BOOTSTRAP_KEY";

export interface BootstrapKeyResult {
  key: string;
  generated: boolean;
  envFilePath: string;
}

export class BootstrapKeyEnvUnwritableError extends Error {
  readonly envFilePath: string;
  readonly cause: unknown;

  constructor(envFilePath: string, cause: unknown) {
    super(
      `${BOOTSTRAP_KEY_ENV_VAR} missing and .env (${envFilePath}) is not writable. ` +
        `Generate a key and add it manually as ${BOOTSTRAP_KEY_ENV_VAR}=<hex>.`
    );
    this.name = "BootstrapKeyEnvUnwritableError";
    this.envFilePath = envFilePath;
    this.cause = cause;
  }
}

export interface LoadOrGenerateBootstrapKeyOptions {
  envFilePath?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  randomBytes?: (size: number) => Buffer;
  appendFileSync?: (filePath: string, contents: string) => void;
}

/**
 * Reads MERIDIAN_INTERNAL_BOOTSTRAP_KEY from process.env. If absent, generates
 * a fresh 32-byte hex value, appends it to .env, and sets it on process.env so
 * deriveBuiltinCallerKey works in the same process.
 *
 * PM Blocker #1: when the key is missing AND .env is not writable, throw
 * BootstrapKeyEnvUnwritableError with a clear message naming the path and
 * variable. NEVER silently regenerate per boot.
 */
export function loadOrGenerateBootstrapKey(
  options: LoadOrGenerateBootstrapKeyOptions = {}
): BootstrapKeyResult {
  const env = options.env ?? process.env;
  const envFilePath = options.envFilePath ?? path.resolve(process.cwd(), ".env");
  const existing = env[BOOTSTRAP_KEY_ENV_VAR];
  if (typeof existing === "string" && existing.trim().length > 0) {
    return { key: existing.trim(), generated: false, envFilePath };
  }

  const randomBytes = options.randomBytes ?? ((size: number) => crypto.randomBytes(size));
  const key = randomBytes(32).toString("hex");

  const appendFileSync =
    options.appendFileSync ??
    ((filePath: string, contents: string) => {
      fs.appendFileSync(filePath, contents, "utf8");
    });

  try {
    appendFileSync(envFilePath, `\n${BOOTSTRAP_KEY_ENV_VAR}=${key}\n`);
  } catch (error) {
    throw new BootstrapKeyEnvUnwritableError(envFilePath, error);
  }

  env[BOOTSTRAP_KEY_ENV_VAR] = key;
  if (env !== process.env) {
    process.env[BOOTSTRAP_KEY_ENV_VAR] = key;
  }

  options.logger?.warn(
    {
      trace_id: null,
      thread_id: null,
      env_file: envFilePath
    },
    `${BOOTSTRAP_KEY_ENV_VAR} generated and appended to .env (one-time)`
  );

  return { key, generated: true, envFilePath };
}

export interface HubServerOptions {
  socketPath?: string;
  router?: HubRouter;
  resultSender?: ResultSender;
  staticServiceEndpoints?: ServiceEndpoint[];
  outputBus?: OutputBus;
  /**
   * Override the credentials root used when bootstrapping the default
   * CredentialStore. Precedence: explicit option > MERIDIAN_CREDENTIALS_ROOT
   * env config > dirname(MERIDIAN_STATE_PATH)/credentials. Only consulted when
   * `router` is NOT provided (i.e. we're constructing the default router).
   */
  credentialsRoot?: string;
}

export function resolveStaticServiceEndpoints(appConfig: AppConfig = config): ServiceEndpoint[] {
  if (!appConfig.COORDINATOR_SOCKET_PATH || appConfig.COORDINATOR_INTENTS.length === 0) {
    return [];
  }

  return [
    ServiceEndpointSchema.parse({
      service: "coordinator",
      socket_path: appConfig.COORDINATOR_SOCKET_PATH,
      intents: appConfig.COORDINATOR_INTENTS
    })
  ];
}

interface IdempotencyEntry {
  result: HubResult;
  expiresAt: number;
}

interface PriorityQueueItem {
  priority: number;
  sequence: number;
  raw: string;
  resolve: (result: HubResult | null) => void;
  reject: (error: unknown) => void;
}

const A2A_STREAM_THREAD_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 60 * 1000;
const DEFAULT_PRIORITY = 5;
const MONITOR_EVENT_PRIORITY = 7;
const PUSH_DEDUP_WINDOW_MS = 90 * 1000;
const RUN_COMPLETION_COOLDOWN_MS = 5_000;
const SUMMARY_MARKER_BEGIN = "[[MERIDIAN_SUMMARY_BEGIN";
const SUMMARY_MARKER_END = "[[MERIDIAN_SUMMARY_END";
const IMMEDIATE_INTENTS = new Set([
  "attach",
  "detach",
  "detail",
  "gui",
  "history",
  "interrupt",
  "list",
  "list_models",
  "monitor_manual_update",
  "push",
  "reply",
  "status",
  "terminal_input",
  "capture_interval"
]);

interface PushDedupState {
  fingerprint: string;
  /** Tail of last sent content (last PUSH_DEDUP_TAIL_CHARS) to catch same trace block with different leading text. */
  tailFingerprint: string;
  sentAtMs: number;
}

interface MonitorProgressDispatchContext {
  threadId: string;
  source: AgentType;
  snapshot: string;
  targets: MonitorUpdateDispatch[];
  timestamp: string;
}

interface OutputBusDeliveryContext {
  threadId: string;
  source: AgentType;
  timestamp: string;
  replyChannels: ReplyChannel[];
  historyBacked: boolean;
}

const PUSH_DEDUP_TAIL_CHARS = 600;

export class HubServer {
  private readonly log = createLogger("hub");
  private readonly socketPath: string;
  private readonly router: HubRouter;
  private readonly resultSender: ResultSender;
  private readonly outputBus: OutputBus;
  private readonly staticServiceEndpoints: ServiceEndpoint[];
  private server: net.Server | null = null;
  private monitorProgressTimer: NodeJS.Timeout | null = null;
  private monitorProgressInFlight = false;
  private readonly idempotencyCache = new Map<string, IdempotencyEntry>();
  private idempotencyCleanupTimer: NodeJS.Timeout | null = null;
  private readonly priorityQueue: PriorityQueueItem[] = [];
  private priorityQueueSequence = 0;
  private priorityQueueDraining = false;
  private readonly lastPushDedupByThread = new Map<string, PushDedupState>();
  private readonly monitorProgressContextByTrace = new Map<string, MonitorProgressDispatchContext>();
  private readonly outputBusDeliveryContextByTrace = new Map<string, OutputBusDeliveryContext>();
  private readonly outputBusThreadByTrace = new Map<string, string>();
  private readonly websocketSubscribersByThread = new Map<string, Set<net.Socket>>();

  constructor(options: HubServerOptions = {}) {
    this.socketPath = options.socketPath ?? config.HUB_SOCKET_PATH;
    if (options.router) {
      this.router = options.router;
    } else {
      const statePath = config.MERIDIAN_STATE_PATH;
      const configuredCredentialsRoot = config.MERIDIAN_CREDENTIALS_ROOT;
      const credentialsRoot =
        options.credentialsRoot ??
        (configuredCredentialsRoot && configuredCredentialsRoot.trim() !== ""
          ? configuredCredentialsRoot
          : path.join(path.dirname(statePath), "credentials"));
      const nowIso = new Date().toISOString();
      let initialCredentials: CredentialRecord[] = [];
      try {
        initialCredentials = (loadPersistedHubState(statePath, nowIso).credentials ?? []) as CredentialRecord[];
      } catch {
        initialCredentials = [];
      }
      const credentialStore = new CredentialStore({
        initialRecords: initialCredentials,
        credentialsRoot,
        // Enable host-default discovery in production so the Accounts UI
        // surfaces the user's ambient ~/.codex and ~/.claude logins as
        // read-only "Default" rows + automatic fallback target.
        discoverHostDefaults: () => discoverHostDefaultsFromHome()
      });
      try {
        credentialStore.reconcile();
      } catch (err) {
        this.log.warn(
          {
            trace_id: null,
            thread_id: null,
            credentials_root: credentialsRoot,
            err: err instanceof Error ? err.message : String(err)
          },
          "CredentialStore reconcile failed (continuing)"
        );
      }
      // Eagerly create the credentials root so operators can verify the new code
      // shipped without having to add a credential first.
      try {
        fs.mkdirSync(credentialsRoot, { recursive: true, mode: 0o700 });
      } catch (err) {
        this.log.warn(
          {
            trace_id: null,
            thread_id: null,
            credentials_root: credentialsRoot,
            err: err instanceof Error ? err.message : String(err)
          },
          "Failed to eagerly create credentials root (continuing)"
        );
      }
      const oauthLoginRegistry = new OAuthLoginJobRegistry();
      const routerOptions: HubRouterOptions = {
        credentialStore,
        oauthLoginRegistry
      };
      if (options.outputBus) routerOptions.outputBus = options.outputBus;
      this.router = new HubRouter(new InstanceRegistry(), routerOptions);
    }
    this.resultSender = options.resultSender ?? new ResultSender([
      new SocketChannelAdapter(),
      new TelegramChannelAdapter(),
      new WebChannelAdapter()
    ]);
    this.outputBus = options.outputBus ?? this.resolveOutputBusFromRouter(this.router);
    this.staticServiceEndpoints = options.staticServiceEndpoints ?? resolveStaticServiceEndpoints();
    this.outputBus.setAdapterOutput((traceId, _message, delta) => this.dispatchOutputBusDelta(traceId, delta));
    this.outputBus.setWebsocketOutput((traceId, message) => this.dispatchOutputBusWebsocketMessage(traceId, message));
    this.outputBus.setRecordOutput((traceId) => this.recordMonitorProgressSnapshot(traceId));
  }

  /** Test seam: returns the underlying router for assertion in bootstrap tests. */
  getRouter(): HubRouter {
    return this.router;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    loadOrGenerateBootstrapKey({ logger: this.log });

    await this.removeStaleSocket();
    await this.router.initialize();
    this.router.ensureBuiltinCallers(BUILTIN_CALLERS, deriveBuiltinCallerKey);
    for (const endpoint of this.staticServiceEndpoints) {
      this.router.registerServiceEndpoint(endpoint);
    }

    this.server = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.setEncoding("utf8");
      let raw = "";
      let pending = Promise.resolve();

      socket.on("data", (chunk: string) => {
        raw += chunk;
        const frames = raw.split("\n");
        raw = frames.pop() ?? "";
        for (const frame of frames) {
          const payload = frame.trim();
          if (!payload) {
            continue;
          }
          pending = pending
            .then(() => this.handleSocketPayload(socket, payload, false))
            .catch((error) => {
              this.log.error({ trace_id: null, thread_id: null, err: String(error) }, "Hub socket frame failed");
              if (socket.writable) {
                socket.end();
              }
            });
        }
      });

      socket.on("end", () => {
        pending = pending
          .then(async () => {
            const payload = raw.trim();
            if (!payload) {
              if (socket.writable) {
                socket.end();
              }
              return;
            }
            await this.handleSocketPayload(socket, payload, true);
          })
          .catch((error) => {
            this.log.error({ trace_id: null, thread_id: null, err: String(error) }, "Hub socket response failed");
            if (socket.writable) {
              socket.end();
            }
          });
      });

      socket.on("error", (error) => {
        this.cleanupWebsocketSubscriptions(socket);
        this.log.error({ trace_id: null, thread_id: null, err: String(error) }, "Hub socket connection failed");
      });

      socket.on("close", () => {
        this.cleanupWebsocketSubscriptions(socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, () => resolve());
    });

    this.startMonitorProgressTicker();
    this.startIdempotencyCleanup();

    this.log.info({ trace_id: null, thread_id: null, socket_path: this.socketPath }, "Hub server listening");
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    // Flush in-memory hub state to disk BEFORE closing the listening
    // socket. Without this, any instance registered since the last route()
    // call (e.g., a spawn whose readiness wait is still in-flight, or a
    // mutation by the periodic monitor ticker) is silently discarded when
    // pm2 sends SIGTERM. The next hub generation rehydrates a stale
    // state.json and surfaces `thread_id=X is not registered` errors.
    try {
      this.router.persistOnShutdown();
    } catch (error) {
      this.log.warn(
        {
          trace_id: null,
          thread_id: null,
          err: error instanceof Error ? error.message : String(error)
        },
        "Final state flush on shutdown threw — continuing teardown"
      );
    }

    const server = this.server;
    this.server = null;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });

    this.stopMonitorProgressTicker();
    this.stopIdempotencyCleanup();
    this.clearPushAccumulators();
    // Do NOT unlink this.socketPath on stop. PM2's restart races the old
    // hub's graceful shutdown against the new hub's bind: if the old hub
    // unlinks AFTER the new hub binds (it can take a few seconds for the
    // old process to drain idempotency cleanup + pane broadcaster close),
    // the directory entry disappears even though the new hub's fd is
    // still alive, and downstream meridian-roles fails its
    // hub_socket_reachable check on /tmp/hub-core.sock. Leaving the
    // stale entry is harmless — start() always calls removeStaleSocket()
    // before listen(), and Node will refuse to bind a path with a live
    // listener (EADDRINUSE). The kernel reclaims the inode when the
    // last fd closes.
    this.log.info({ trace_id: null, thread_id: null, socket_path: this.socketPath }, "Hub server stopped");
  }

  private async handleSocketPayload(socket: net.Socket, raw: string, closeOnComplete: boolean): Promise<void> {
    if (this.handleA2AStreamSubscription(socket, raw)) {
      return;
    }

    const result = await this.enqueueMessage(raw);
    if (!socket.writable) {
      return;
    }
    if (!result) {
      if (closeOnComplete) {
        socket.end();
      }
      return;
    }
    if (closeOnComplete) {
      socket.end(JSON.stringify(result));
      return;
    }
    socket.write(`${JSON.stringify(result)}\n`);
  }

  private handleA2AStreamSubscription(socket: net.Socket, raw: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return false;
    }

    if (!parsed || typeof parsed !== "object") {
      return false;
    }

    const frame = parsed as Record<string, unknown>;
    if (frame.type !== "a2a_stream_subscribe") {
      return false;
    }

    const threadId = typeof frame.thread_id === "string" ? frame.thread_id.trim() : "";
    if (!threadId || !A2A_STREAM_THREAD_ID_PATTERN.test(threadId)) {
      if (socket.writable) {
        socket.end(`${JSON.stringify({ type: "a2a_stream_error", error: "Invalid thread_id" })}\n`);
      }
      return true;
    }

    this.registerWebsocketSubscriber(threadId, socket);
    return true;
  }

  private enqueueMessage(raw: string): Promise<HubResult | null> {
    if (this.shouldHandleImmediately(raw)) {
      return this.handleRawPayload(raw);
    }

    const priority = this.extractPriorityFromRaw(raw);
    return new Promise<HubResult | null>((resolve, reject) => {
      const item: PriorityQueueItem = {
        priority,
        sequence: this.priorityQueueSequence++,
        raw,
        resolve,
        reject
      };

      this.insertIntoQueue(item);
      void this.drainPriorityQueue();
    });
  }

  private insertIntoQueue(item: PriorityQueueItem): void {
    let insertIndex = this.priorityQueue.length;
    for (let i = 0; i < this.priorityQueue.length; i++) {
      const existing = this.priorityQueue[i];
      if (item.priority < existing.priority || (item.priority === existing.priority && item.sequence < existing.sequence)) {
        insertIndex = i;
        break;
      }
    }
    this.priorityQueue.splice(insertIndex, 0, item);
  }

  private async drainPriorityQueue(): Promise<void> {
    if (this.priorityQueueDraining) {
      return;
    }

    this.priorityQueueDraining = true;
    try {
      while (this.priorityQueue.length > 0) {
        const item = this.priorityQueue.shift()!;
        // Fire-and-forget: allow concurrent item processing so that
        // inner messages (spawn/run/kill from a running dispatcher agent)
        // are not starved while the outer handleRun() awaits agent completion.
        void this.processQueueItem(item);
      }
    } finally {
      this.priorityQueueDraining = false;
    }
  }

  private async processQueueItem(item: PriorityQueueItem): Promise<void> {
    try {
      const result = await this.handleRawPayload(item.raw);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    }
  }

  private extractPriorityFromRaw(raw: string): number {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.priority === "number" && Number.isInteger(parsed.priority)) {
        return parsed.priority;
      }
      const monitorEvent = MonitorEventSchema.safeParse(parsed);
      if (monitorEvent.success) {
        return MONITOR_EVENT_PRIORITY;
      }
    } catch {
      // Best-effort priority extraction
    }
    return DEFAULT_PRIORITY;
  }

  private shouldHandleImmediately(raw: string): boolean {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (MonitorEventSchema.safeParse(parsed).success) {
        return false;
      }
      const message = HubMessageSchema.safeParse(parsed);
      return message.success && IMMEDIATE_INTENTS.has(message.data.intent);
    } catch {
      return false;
    }
  }

  private async handleRawPayload(raw: string): Promise<HubResult | null> {
    let message: HubMessage | null = null;

    try {
      if (!raw.trim()) {
        throw new Error("Empty IPC payload");
      }

      const parsed = JSON.parse(raw) as unknown;
      const monitorEvent = MonitorEventSchema.safeParse(parsed);
      if (monitorEvent.success) {
        await this.handleMonitorEvent(monitorEvent.data);
        return null;
      }

      let auth: WireAuth | null = null;
      let messagePayload: unknown = parsed;
      const envelope = unwrapWireFrame(parsed);
      if (envelope) {
        auth = envelope.auth;
        messagePayload = envelope.message;
      }

      message = this.normalizeIncomingMessage(messagePayload);
      this.injectSpanId(message);

      const cachedResult = this.checkIdempotency(message);
      if (cachedResult) {
        return cachedResult;
      }

      this.outputBusThreadByTrace.set(message.trace_id, message.thread_id);
      const result = await this.router.route(message, auth);
      const validatedResult = HubResultSchema.parse(result);
      this.cacheIdempotencyResult(message, validatedResult);
      if (!message.suppress_reply) {
        await this.sendUnifiedReply(message, validatedResult);
      }
      return validatedResult;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.log.error(
        {
          trace_id: message?.trace_id ?? null,
          thread_id: message?.thread_id ?? null,
          err: errorMessage
        },
        "Failed to process inbound hub payload"
      );

      if (!message) {
        return null;
      }

      const fallbackResult: HubResult = HubResultSchema.parse({
        trace_id: message.trace_id,
        thread_id: message.thread_id,
        source: this.resolveSource(message.target),
        status: "error",
        content: `Hub processing failed: ${errorMessage}`,
        attachments: [],
        timestamp: new Date().toISOString()
      });

      if (!message.suppress_reply) {
        await this.resultSender.sendResult(fallbackResult, message.reply_channel).catch((sendError) => {
          this.log.error(
            {
              trace_id: message?.trace_id ?? null,
              thread_id: message?.thread_id ?? null,
              err: sendError instanceof Error ? sendError.message : String(sendError)
            },
            "Failed to deliver fallback HubResult"
          );
        });
      }
      return fallbackResult;
    } finally {
      if (message) {
        this.outputBusThreadByTrace.delete(message.trace_id);
      }
    }
  }

  private async handleMonitorEvent(event: MonitorEvent): Promise<void> {
    this.log.info(
      {
        trace_id: event.trace_id,
        thread_id: event.thread_id,
        event_type: event.event_type,
        monitor_mode: event.monitor_mode,
        agent_status: event.agent_status,
        missed_heartbeats: event.missed_heartbeats,
        sse_reconnect_count: event.sse_reconnect_count
      },
      "Monitor event received by hub"
    );

    if (event.event_type === "status_changed" && event.agent_status) {
      this.router.setInstanceStatus(event.thread_id, event.agent_status);
      if (this.router.isThreadRunning(event.thread_id)) {
        this.router.forceMonitorUpdateDispatchNow(event.thread_id);
      }
    }
    if (event.event_type === "task_completed") {
      // Always stop periodic /update pushes once the task is complete.
      this.router.setInstanceStatus(event.thread_id, "waiting");
      await this.deliverMonitorCompletionResult(event);
      return;
    }
    if (event.event_type === "agent_error" || event.event_type === "sse_reconnect_failed") {
      this.router.setInstanceStatus(event.thread_id, "error");
    }

    if (!this.shouldSendMonitorAlert(event)) {
      return;
    }

    const sessionTargets = this.collectMonitorAlertTargets(event.thread_id);
    if (sessionTargets.length === 0) {
      this.log.warn(
        {
          trace_id: event.trace_id,
          thread_id: event.thread_id,
          event_type: event.event_type
        },
        "Monitor alert skipped because no session is attached to thread"
      );
      return;
    }

    const traceId = event.trace_id ?? randomUUID();
    const source = this.router.resolveSourceForThread(event.thread_id);
    const content = this.formatMonitorAlert(event, traceId);
    for (const sessionTarget of sessionTargets) {
      const replyChannel = this.router.resolveReplyChannelForSession(sessionTarget);
      await this.resultSender
        .sendResult(
          {
            trace_id: traceId,
            thread_id: event.thread_id,
            source,
            status: "error",
            content,
            attachments: [],
            telegram_inline_keyboard:
              event.event_type === "agent_error" ? buildAgentErrorInlineKeyboard(event.thread_id) : undefined,
            timestamp: new Date().toISOString()
          },
          replyChannel
        )
        .catch((error) => {
          this.log.error(
            {
              trace_id: traceId,
              thread_id: event.thread_id,
              target: replyChannel.chat_id,
              bot_id: replyChannel.bot_id ?? null,
              event_type: event.event_type,
              err: error instanceof Error ? error.message : String(error)
            },
            "Failed to deliver monitor alert"
          );
        });
    }
  }

  private async deliverMonitorCompletionResult(event: MonitorEvent): Promise<void> {
    const allTargets = this.collectMonitorCompletionTargets(event.thread_id);
    const pushKeys = this.getPushSubscriberSessionKeys(event.thread_id);
    const sessionTargets = allTargets.filter((session) => !pushKeys.has(session));
    if (sessionTargets.length === 0) {
      if (allTargets.length > 0) {
        this.log.debug(
          { thread_id: event.thread_id, event_type: event.event_type },
          "Monitor completion skipped: all recipients are push subscribers (they get pane push only)"
        );
      } else {
        this.log.warn(
          {
            trace_id: event.trace_id,
            thread_id: event.thread_id,
            event_type: event.event_type
          },
          "Monitor completion skipped because no recipient is registered for thread"
        );
      }
      return;
    }

    const traceId = event.trace_id ?? randomUUID();
    let completionResult: HubResult;
    try {
      completionResult = await this.router.buildCompletionResultForThread(event.thread_id, traceId);
    } catch (error) {
      this.log.error(
        {
          trace_id: traceId,
          thread_id: event.thread_id,
          event_type: event.event_type,
          err: error instanceof Error ? error.message : String(error)
        },
        "Failed to build monitor completion result"
      );
      return;
    }

    this.recordAgentPushConversationSafe(event.thread_id, completionResult.content, completionResult.trace_id, "final_reply");
    for (const sessionTarget of sessionTargets) {
      const replyChannel = this.router.resolveReplyChannelForSession(sessionTarget);
      await this.resultSender
        .sendResult(this.buildHistoryBackedResult(completionResult), replyChannel)
        .catch((error) => {
          this.log.error(
            {
              trace_id: traceId,
              thread_id: event.thread_id,
              target: replyChannel.chat_id,
              bot_id: replyChannel.bot_id ?? null,
              event_type: event.event_type,
              err: error instanceof Error ? error.message : String(error)
            },
            "Failed to deliver monitor completion result"
          );
        });
    }
  }

  private shouldSendMonitorAlert(event: MonitorEvent): boolean {
    if (event.event_type === "agent_error" || event.event_type === "sse_reconnect_failed") {
      return true;
    }
    if (event.event_type === "heartbeat_missed") {
      return (event.missed_heartbeats ?? 0) === config.HEARTBEAT_MISSED_THRESHOLD;
    }
    return false;
  }

  private formatMonitorAlert(event: MonitorEvent, traceId: string): string {
    const lines = [
      `Monitor alert: ${event.event_type}`,
      `thread=${event.thread_id}`,
      `trace=${traceId}`,
      `mode=${event.monitor_mode}`
    ];

    if (event.agent_type) {
      lines.push(`agent_type=${event.agent_type}`);
    }
    if (event.last_known_pid !== undefined) {
      lines.push(`last_known_pid=${event.last_known_pid}`);
    }
    if (event.agent_status) {
      lines.push(`agent_status=${event.agent_status}`);
    }
    const reason = event.details?.reason;
    if (typeof reason === "string") {
      lines.push(`reason=${reason}`);
    }
    if (event.missed_heartbeats !== undefined) {
      lines.push(`missed_heartbeats=${event.missed_heartbeats}`);
    }
    if (event.sse_reconnect_count !== undefined) {
      lines.push(`sse_reconnect_count=${event.sse_reconnect_count}`);
    }
    if (event.error) {
      lines.push(`error=${event.error}`);
    }

    if (event.event_type === "agent_error") {
      lines.push("Recommended action: /status or /restart");
    } else if (event.event_type === "sse_reconnect_failed") {
      lines.push("Monitor switched to heartbeat fallback");
    }

    return lines.join("\n");
  }

  private collectMonitorCompletionTargets(threadId: string): string[] {
    const attachedSessions = this.router.getAttachedSessionsForThread(threadId);
    const monitorSubscribers = this.router.getMonitorUpdateSubscribersForThread(threadId);
    return [...new Set([...attachedSessions, ...monitorSubscribers])];
  }

  private collectMonitorAlertTargets(threadId: string): string[] {
    const attachedSessions = this.router.getAttachedSessionsForThread(threadId);
    const monitorSubscribers = this.router.getMonitorUpdateSubscribersForThread(threadId);
    return [...new Set([...attachedSessions, ...monitorSubscribers])];
  }

  private startMonitorProgressTicker(): void {
    if (this.monitorProgressTimer) {
      return;
    }
    this.monitorProgressTimer = setInterval(() => {
      void this.flushMonitorProgressUpdates();
    }, config.MONITOR_PROGRESS_TICK_MS);
    this.monitorProgressTimer.unref();
  }

  private stopMonitorProgressTicker(): void {
    if (!this.monitorProgressTimer) {
      return;
    }
    clearInterval(this.monitorProgressTimer);
    this.monitorProgressTimer = null;
  }

  private async flushMonitorProgressUpdates(): Promise<void> {
    if (this.monitorProgressInFlight) {
      return;
    }

    this.monitorProgressInFlight = true;
    try {
      const dispatches = this.router.collectDueMonitorUpdateDispatches();
      if (dispatches.length === 0) {
        return;
      }

      const chatTargetsByThread = this.groupMonitorDispatchesByThread(dispatches);
      for (const [threadId, targets] of chatTargetsByThread.entries()) {
        if (targets.length === 0) {
          continue;
        }
        if (this.isRunActiveForThreadSafe(threadId) || this.isWithinRunCooldownSafe(threadId)) {
          continue;
        }
        const pushKeys = this.getPushSubscriberSessionKeys(threadId);
        const targetsToNotify = targets.filter(
          (t) => !pushKeys.has(t.botId ? `${t.botId}:${t.chatId}` : t.chatId)
        );
        if (targetsToNotify.length === 0) {
          continue;
        }

        const requestedTraceId = randomUUID();
        let progressSnapshot: ThreadProgressSnapshot;
        try {
          progressSnapshot = await this.router.buildProgressSnapshotForThread(threadId, requestedTraceId);
        } catch (error) {
          this.log.error(
            {
              trace_id: requestedTraceId,
              thread_id: threadId,
              err: error instanceof Error ? error.message : String(error)
            },
            "Failed to build monitor progress result"
          );
          continue;
        }
        const traceId = progressSnapshot.trace_id;
        const progressResult = this.buildMonitorProgressResult(progressSnapshot);
        if (!shouldPushTelegramProactive(progressResult)) {
          this.log.info(
            {
              trace_id: traceId,
              thread_id: threadId,
              reason: "telegram_push_whitelist"
            },
            "Skipped proactive Telegram progress update"
          );
          continue;
        }

        const replyChannels = targetsToNotify.map((target) =>
          target.replyChannel ?? {
            channel: "telegram",
            chat_id: target.chatId,
            ...(target.botId ? { bot_id: target.botId } : {})
          }
        );
        this.monitorProgressContextByTrace.set(traceId, {
          threadId,
          source: progressSnapshot.source,
          snapshot: progressSnapshot.content,
          targets: targetsToNotify,
          timestamp: progressSnapshot.updated_at
        });
        this.outputBusDeliveryContextByTrace.set(traceId, {
          threadId,
          source: progressSnapshot.source,
          timestamp: progressSnapshot.updated_at,
          replyChannels,
          historyBacked: false
        });
        try {
          this.outputBus.pushSnapshot(traceId, progressSnapshot.content);
        } finally {
          this.outputBusDeliveryContextByTrace.delete(traceId);
          this.monitorProgressContextByTrace.delete(traceId);
        }
      }
    } finally {
      this.monitorProgressInFlight = false;
    }
  }

  private resolveOutputBusFromRouter(router: HubRouter): OutputBus {
    const candidate = router as unknown as { getOutputBus?: () => OutputBus };
    return candidate.getOutputBus?.() ?? new OutputBus();
  }

  private buildMonitorProgressResult(snapshot: ThreadProgressSnapshot): HubResult {
    return HubResultSchema.parse({
      trace_id: snapshot.trace_id,
      thread_id: snapshot.thread_id,
      source: snapshot.source,
      status: "partial",
      content: snapshot.content,
      progress: snapshot,
      attachments: [],
      timestamp: snapshot.updated_at
    });
  }

  private async dispatchOutputBusDelta(traceId: string, delta: OutputDelta): Promise<void> {
    const context = this.outputBusDeliveryContextByTrace.get(traceId);
    if (!context) {
      return;
    }

    const result = HubResultSchema.parse({
      trace_id: traceId,
      thread_id: context.threadId,
      source: context.source,
      status: delta.phase === "error" ? "error" : delta.phase === "result" ? "success" : "partial",
      content: delta.text ?? "",
      attachments: [],
      timestamp: context.timestamp
    });
    const outbound = context.historyBacked ? this.buildHistoryBackedResult(result) : result;

    for (const replyChannel of context.replyChannels) {
      await this.resultSender.sendResult(outbound, replyChannel).catch((error) => {
        this.log.error(
          {
            trace_id: traceId,
            thread_id: context.threadId,
            target: replyChannel.chat_id,
            bot_id: replyChannel.bot_id ?? null,
            err: error instanceof Error ? error.message : String(error)
          },
          "Failed to deliver monitor progress update"
        );
      });
    }
  }

  private dispatchOutputBusWebsocketMessage(traceId: string, message: A2AMessage): void {
    const threadId =
      this.outputBusDeliveryContextByTrace.get(traceId)?.threadId ?? this.outputBusThreadByTrace.get(traceId) ?? null;
    if (!threadId) {
      return;
    }

    const payload = JSON.stringify({
      type: "a2a_message",
      ...message
    });
    appendA2AWebSocketLog(config.LOG_DIR, threadId, payload);

    const subscribers = this.websocketSubscribersByThread.get(threadId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    for (const socket of [...subscribers]) {
      if (!this.writeWebsocketPayload(socket, payload)) {
        subscribers.delete(socket);
      }
    }

    if (subscribers.size === 0) {
      this.websocketSubscribersByThread.delete(threadId);
    }
  }

  private recordMonitorProgressSnapshot(traceId: string): void {
    const context = this.monitorProgressContextByTrace.get(traceId);
    if (!context) {
      return;
    }
    this.recordAgentPushConversationSafe(context.threadId, context.snapshot, traceId, "progress");
  }

  private groupMonitorDispatchesByThread(dispatches: MonitorUpdateDispatch[]): Map<string, MonitorUpdateDispatch[]> {
    const byThread = new Map<string, MonitorUpdateDispatch[]>();
    for (const dispatch of dispatches) {
      const existing = byThread.get(dispatch.threadId);
      if (existing) {
        existing.push(dispatch);
        continue;
      }
      byThread.set(dispatch.threadId, [dispatch]);
    }
    return byThread;
  }

  private normalizeIncomingMessage(payload: unknown): HubMessage {
    const hubMessage = HubMessageSchema.safeParse(payload);
    if (hubMessage.success) {
      return hubMessage.data;
    }

    const envelope = payload as InboundEnvelope;
    if (envelope && typeof envelope === "object" && "event" in envelope) {
      const normalizedEvent = InboundUIEventSchema.parse(envelope.event);
      const chatId = envelope.chatId ?? envelope.chat_id;
      if (!chatId) {
        throw new Error("Inbound envelope is missing chatId");
      }

      return normalizeInboundEvent(normalizedEvent, { chatId });
    }

    throw new Error(`Invalid HubMessage payload: ${hubMessage.error.issues.map((issue) => issue.message).join("; ")}`);
  }

  private resolveSource(target: string): AgentType {
    const parsed = AgentTypeSchema.safeParse(target);
    if (parsed.success) {
      return parsed.data;
    }
    return "codex";
  }

  private injectSpanId(message: HubMessage): void {
    if (!message.span_id) {
      (message as Record<string, unknown>).span_id = randomUUID();
    }
  }

  private checkIdempotency(message: HubMessage): HubResult | null {
    const key = message.idempotency_key;
    if (!key) {
      return null;
    }

    const entry = this.idempotencyCache.get(key);
    if (!entry || entry.expiresAt < Date.now()) {
      return null;
    }

    this.log.info(
      {
        trace_id: message.trace_id,
        thread_id: message.thread_id,
        idempotency_key: key
      },
      "Duplicate message suppressed"
    );
    return entry.result;
  }

  private cacheIdempotencyResult(message: HubMessage, result: HubResult): void {
    const key = message.idempotency_key;
    if (!key) {
      return;
    }
    this.idempotencyCache.set(key, {
      result,
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS
    });
  }

  private startIdempotencyCleanup(): void {
    if (this.idempotencyCleanupTimer) {
      return;
    }
    this.idempotencyCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.idempotencyCache) {
        if (entry.expiresAt < now) {
          this.idempotencyCache.delete(key);
        }
      }
    }, IDEMPOTENCY_CLEANUP_INTERVAL_MS);
    this.idempotencyCleanupTimer.unref();
  }

  private stopIdempotencyCleanup(): void {
    if (!this.idempotencyCleanupTimer) {
      return;
    }
    clearInterval(this.idempotencyCleanupTimer);
    this.idempotencyCleanupTimer = null;
    this.idempotencyCache.clear();
  }

  private registerWebsocketSubscriber(threadId: string, socket: net.Socket): void {
    const existing = this.websocketSubscribersByThread.get(threadId);
    if (existing) {
      existing.add(socket);
      return;
    }
    this.websocketSubscribersByThread.set(threadId, new Set([socket]));
  }

  private unregisterWebsocketSubscriber(threadId: string, socket: net.Socket): void {
    const existing = this.websocketSubscribersByThread.get(threadId);
    if (!existing) {
      return;
    }
    existing.delete(socket);
    if (existing.size === 0) {
      this.websocketSubscribersByThread.delete(threadId);
    }
  }

  private cleanupWebsocketSubscriptions(socket: net.Socket): void {
    for (const [threadId, subscribers] of this.websocketSubscribersByThread.entries()) {
      subscribers.delete(socket);
      if (subscribers.size === 0) {
        this.websocketSubscribersByThread.delete(threadId);
      }
    }
  }

  private writeWebsocketPayload(socket: net.Socket, payload: string): boolean {
    if (socket.destroyed || !socket.writable) {
      return false;
    }
    socket.write(`${payload}\n`);
    return true;
  }

  private getPushSubscriptionsForThreadSafe(threadId: string): PushDeliveryTarget[] {
    const candidate = this.router as unknown as {
      getPushSubscriptionsForThread?: (id: string) => Array<{ chatId: string; botId?: string; replyChannel: ReplyChannel }>;
    };
    const subscriptions = candidate.getPushSubscriptionsForThread?.(threadId) ?? [];
    return subscriptions.map((entry) => ({ threadId, chatId: entry.chatId, botId: entry.botId, replyChannel: entry.replyChannel }));
  }

  /** Session keys for push subscribers (chatId or botId:chatId) so we can skip sending them monitor completion/progress (they get pane push only). */
  private getPushSubscriberSessionKeys(threadId: string): Set<string> {
    const subs = this.getPushSubscriptionsForThreadSafe(threadId);
    const keys = new Set<string>();
    for (const sub of subs) {
      keys.add(sub.botId ? `${sub.botId}:${sub.chatId}` : sub.chatId);
    }
    return keys;
  }

  private isRunActiveForThreadSafe(threadId: string): boolean {
    const candidate = this.router as unknown as {
      isRunActiveForThread?: (id: string) => boolean;
    };
    return candidate.isRunActiveForThread?.(threadId) ?? false;
  }

  private isWithinRunCooldownSafe(threadId: string): boolean {
    const candidate = this.router as unknown as {
      isWithinRunCompletionCooldown?: (id: string, cooldownMs: number) => boolean;
    };
    return candidate.isWithinRunCompletionCooldown?.(threadId, RUN_COMPLETION_COOLDOWN_MS) ?? false;
  }

  private getActiveRunTraceIdSafe(threadId: string): string | null {
    const candidate = this.router as unknown as {
      getActiveRunTraceId?: (id: string) => string | null;
    };
    return candidate.getActiveRunTraceId?.(threadId) ?? null;
  }

  private recordAgentPushConversationSafe(
    threadId: string,
    content: string,
    traceId: string,
    eventKindHint: "progress" | "final_reply" = "progress"
  ): void {
    const candidate = this.router as unknown as {
      recordAgentPushConversation?: (
        id: string,
        rawContent: string,
        traceId: string | null,
        eventKindHint?: "progress" | "final_reply"
      ) => void;
    };
    candidate.recordAgentPushConversation?.(threadId, content, traceId, eventKindHint);
  }

  private getRegistryInstanceSafe(threadId: string): { auto_approve?: boolean } | null {
    const candidate = this.router as unknown as {
      getRegistryInstance?: (id: string) => { auto_approve?: boolean } | undefined;
    };
    return candidate.getRegistryInstance?.(threadId) ?? null;
  }

  private sendAutoApproveInputSafe(threadId: string): void {
    const candidate = this.router as unknown as {
      sendAutoApproveTerminalInput?: (id: string) => void;
    };
    candidate.sendAutoApproveTerminalInput?.(threadId);
  }

  private async sendUnifiedReply(message: HubMessage, result: HubResult): Promise<void> {
    void message;
    await this.resultSender.sendResult(this.buildHistoryBackedResult(result), message.reply_channel);
  }

  private buildHistoryBackedResult(result: HubResult): HubResult {
    const candidate = this.router as unknown as {
      getLatestConversationEntry?: (
        threadId: string,
        traceId?: string | null,
        type?: "user" | "agent" | null
      ) => { raw_content?: string; content?: string; details_text?: string } | null;
    };
    const entry = candidate.getLatestConversationEntry?.(result.thread_id, result.trace_id, "agent") ?? null;
    if (!entry) {
      return result;
    }

    const content =
      (typeof entry.raw_content === "string" && entry.raw_content.trim()) ||
      (typeof entry.details_text === "string" && entry.details_text.trim()) ||
      (typeof entry.content === "string" ? entry.content : "");
    if (!content.trim()) {
      return result;
    }

    return HubResultSchema.parse({
      ...result,
      content,
      summary_text: typeof entry.content === "string" ? entry.content : undefined,
      details_text: typeof entry.details_text === "string" ? entry.details_text : undefined
    });
  }

  private parseSummaryTagId(tagText: string): string | null {
    const matched = tagText.match(/\bid=([0-9a-fA-F-]{36})\b/);
    return matched?.[1]?.toLowerCase() ?? null;
  }

  private extractLatestSummaryBlockAnyTrace(content: string): string | null {
    let cursor = 0;
    let latest: string | null = null;

    while (cursor < content.length) {
      const beginIndex = content.indexOf(SUMMARY_MARKER_BEGIN, cursor);
      if (beginIndex < 0) {
        break;
      }
      const beginClose = content.indexOf("]]", beginIndex);
      if (beginClose < 0) {
        break;
      }
      const beginTag = content.slice(beginIndex, beginClose + 2);
      const beginId = this.parseSummaryTagId(beginTag);
      cursor = beginClose + 2;
      if (!beginId) {
        continue;
      }

      let searchFrom = beginClose + 2;
      while (searchFrom < content.length) {
        const endIndex = content.indexOf(SUMMARY_MARKER_END, searchFrom);
        if (endIndex < 0) {
          break;
        }
        const endClose = content.indexOf("]]", endIndex);
        if (endClose < 0) {
          break;
        }
        const endTag = content.slice(endIndex, endClose + 2);
        const endId = this.parseSummaryTagId(endTag);
        searchFrom = endClose + 2;
        if (!endId || endId !== beginId) {
          continue;
        }
        latest = content.slice(beginClose + 2, endIndex).trim();
        cursor = endClose + 2;
        break;
      }
    }

    return latest && latest.trim() ? latest.trim() : null;
  }

  private isDuplicatePushContent(
    threadId: string,
    content: string,
    options?: { skipTailDedup?: boolean }
  ): boolean {
    const nowMs = Date.now();
    const fingerprint = content.trim();
    const tailFingerprint =
      fingerprint.length > PUSH_DEDUP_TAIL_CHARS
        ? fingerprint.slice(-PUSH_DEDUP_TAIL_CHARS)
        : fingerprint;
    const previous = this.lastPushDedupByThread.get(threadId);
    if (previous && nowMs - previous.sentAtMs < PUSH_DEDUP_WINDOW_MS) {
      if (previous.fingerprint === fingerprint) {
        return true;
      }
      if (
        !options?.skipTailDedup &&
        tailFingerprint.length >= 80 &&
        previous.tailFingerprint === tailFingerprint
      ) {
        return true;
      }
    }
    this.lastPushDedupByThread.set(threadId, {
      fingerprint,
      tailFingerprint,
      sentAtMs: nowMs
    });
    return false;
  }

  private clearPushAccumulators(): void {
    this.lastPushDedupByThread.clear();
    this.outputBusDeliveryContextByTrace.clear();
    this.outputBusThreadByTrace.clear();
    this.websocketSubscribersByThread.clear();
  }

  private async removeStaleSocket(): Promise<void> {
    // Before unlinking, probe to see if another process is actively
    // listening on this path. PM2 routinely spawns transient children
    // during restart races; a blind unlink here would delete the live
    // hub's directory entry while leaving its fd open — meridian-roles
    // then fails hub_socket_reachable on /tmp/hub-core.sock and the
    // chain spirals into ensure_meridian_hub_socket → restart → repeat.
    const liveListener = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(this.socketPath);
      const timer = setTimeout(() => {
        probe.destroy();
        resolve(false);
      }, 250);
      probe.once("connect", () => {
        clearTimeout(timer);
        probe.end();
        resolve(true);
      });
      probe.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (liveListener) {
      throw new Error(
        `Hub socket already in use by a live listener: ${this.socketPath}. Refusing to unlink it.`
      );
    }
    await fs.promises.unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}
