import fs from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";

import { config, type AppConfig } from "../config";
import { createLogger } from "../logger";
import { MonitorEventSchema, type MonitorEvent } from "../monitor/events";
import { buildAgentErrorInlineKeyboard } from "../shared/telegram-controls";
import {
  AgentTypeSchema,
  HubMessageSchema,
  HubResultSchema,
  InboundUIEventSchema,
  PaneSubscribeRequestSchema,
  PaneUnsubscribeRequestSchema,
  ServiceEndpointSchema,
  type ServiceEndpoint,
  type AgentType,
  type HubMessage,
  type HubResult
} from "../types";
import { normalizeInboundEvent } from "./normalizer";
import { PaneBroadcaster } from "./pane-broadcaster";
import { ResultSender, shouldPushTelegramProactive } from "./result-sender";
import { InstanceRegistry } from "./registry";
import { classifyAgentOutput } from "../shared/agent-output";
import { HubRouter, type MonitorUpdateDispatch, type PushDeliveryTarget } from "./router";

interface InboundEnvelope {
  chatId?: string;
  chat_id?: string;
  event: unknown;
}

export interface HubServerOptions {
  socketPath?: string;
  router?: HubRouter;
  resultSender?: ResultSender;
  paneBroadcaster?: PaneBroadcaster;
  staticServiceEndpoints?: ServiceEndpoint[];
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

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 60 * 1000;
const DEFAULT_PRIORITY = 5;
const MONITOR_EVENT_PRIORITY = 7;
const PUSH_DEBOUNCE_MS = 2000;
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
  "list",
  "list_models",
  "push",
  "status",
  "terminal_input",
  "capture_interval"
]);

interface PushAccumulator {
  chunks: string[];
  timer: NodeJS.Timeout;
}

interface PushDedupState {
  fingerprint: string;
  sentAtMs: number;
}

export class HubServer {
  private readonly log = createLogger("hub");
  private readonly socketPath: string;
  private readonly router: HubRouter;
  private readonly resultSender: ResultSender;
  private readonly paneBroadcaster: PaneBroadcaster;
  private readonly staticServiceEndpoints: ServiceEndpoint[];
  private server: net.Server | null = null;
  private monitorProgressTimer: NodeJS.Timeout | null = null;
  private monitorProgressInFlight = false;
  private readonly idempotencyCache = new Map<string, IdempotencyEntry>();
  private idempotencyCleanupTimer: NodeJS.Timeout | null = null;
  private readonly priorityQueue: PriorityQueueItem[] = [];
  private priorityQueueSequence = 0;
  private priorityQueueDraining = false;
  private readonly pushAccumulators = new Map<string, PushAccumulator>();
  private readonly lastPushDedupByThread = new Map<string, PushDedupState>();

  constructor(options: HubServerOptions = {}) {
    this.socketPath = options.socketPath ?? config.HUB_SOCKET_PATH;
    this.router = options.router ?? new HubRouter(new InstanceRegistry());
    this.resultSender = options.resultSender ?? new ResultSender();
    this.paneBroadcaster = options.paneBroadcaster ?? new PaneBroadcaster();
    this.staticServiceEndpoints = options.staticServiceEndpoints ?? resolveStaticServiceEndpoints();
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    await this.removeStaleSocket();
    await this.router.initialize();
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
        this.paneBroadcaster.cleanupSocket(socket);
        this.log.error({ trace_id: null, thread_id: null, err: String(error) }, "Hub socket connection failed");
      });

      socket.on("close", () => {
        this.paneBroadcaster.cleanupSocket(socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, () => resolve());
    });

    this.startMonitorProgressTicker();
    this.startIdempotencyCleanup();
    this.registerPushCallback();

    this.log.info({ trace_id: null, thread_id: null, socket_path: this.socketPath }, "Hub server listening");
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });

    this.stopMonitorProgressTicker();
    this.stopIdempotencyCleanup();
    this.clearPushAccumulators();
    this.paneBroadcaster.close();
    await fs.promises.unlink(this.socketPath).catch(() => undefined);
    this.log.info({ trace_id: null, thread_id: null, socket_path: this.socketPath }, "Hub server stopped");
  }

  private async handleSocketPayload(socket: net.Socket, raw: string, closeOnComplete: boolean): Promise<void> {
    const parsed = JSON.parse(raw) as unknown;
    const subscribeRequest = PaneSubscribeRequestSchema.safeParse(parsed);
    if (subscribeRequest.success) {
      const result = await this.paneBroadcaster.subscribe(
        socket,
        this.router.resolveInstanceForThread(subscribeRequest.data.thread_id),
        subscribeRequest.data
      );
      if (result.kind === "not_available" && socket.writable) {
        socket.end(JSON.stringify(result.payload));
      }
      return;
    }

    const unsubscribeRequest = PaneUnsubscribeRequestSchema.safeParse(parsed);
    if (unsubscribeRequest.success) {
      this.paneBroadcaster.unsubscribe(socket, unsubscribeRequest.data.thread_id);
      if (closeOnComplete && socket.writable) {
        socket.end();
      } else if (socket.writable) {
        socket.write('{"ok":true}\n');
      }
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
        try {
          const result = await this.handleRawPayload(item.raw);
          item.resolve(result);
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.priorityQueueDraining = false;
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

      message = this.normalizeIncomingMessage(parsed);
      this.injectSpanId(message);

      const cachedResult = this.checkIdempotency(message);
      if (cachedResult) {
        return cachedResult;
      }

      const result = await this.router.route(message);
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
      const replyTarget = this.parseReplyTarget(sessionTarget);
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
          {
            channel: "telegram",
            chat_id: replyTarget.chatId,
            bot_id: replyTarget.botId
          }
        )
        .catch((error) => {
          this.log.error(
            {
              trace_id: traceId,
              thread_id: event.thread_id,
              target: replyTarget.chatId,
              bot_id: replyTarget.botId ?? null,
              event_type: event.event_type,
              err: error instanceof Error ? error.message : String(error)
            },
            "Failed to deliver monitor alert to Telegram"
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

    this.recordAgentPushConversationSafe(event.thread_id, completionResult.content, completionResult.trace_id);
    for (const sessionTarget of sessionTargets) {
      const replyTarget = this.parseReplyTarget(sessionTarget);
      await this.resultSender
        .sendResult(this.buildHistoryBackedResult(completionResult), {
          channel: "telegram",
          chat_id: replyTarget.chatId,
          bot_id: replyTarget.botId
        })
        .catch((error) => {
          this.log.error(
            {
              trace_id: traceId,
              thread_id: event.thread_id,
              target: replyTarget.chatId,
              bot_id: replyTarget.botId ?? null,
              event_type: event.event_type,
              err: error instanceof Error ? error.message : String(error)
            },
            "Failed to deliver monitor completion result to Telegram"
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

        const traceId = randomUUID();
        let progressResult: HubResult;
        try {
          progressResult = await this.router.buildProgressResultForThread(threadId, traceId);
        } catch (error) {
          this.log.error(
            {
              trace_id: traceId,
              thread_id: threadId,
              err: error instanceof Error ? error.message : String(error)
            },
            "Failed to build monitor progress result"
          );
          continue;
        }
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

        this.recordAgentPushConversationSafe(threadId, progressResult.content, progressResult.trace_id);
        for (const target of targetsToNotify) {
          await this.resultSender
            .sendResult(this.buildHistoryBackedResult(progressResult), {
              channel: "telegram",
              chat_id: target.chatId,
              bot_id: target.botId
            })
            .catch((error) => {
              this.log.error(
                {
                  trace_id: traceId,
                  thread_id: threadId,
                  target: target.chatId,
                  bot_id: target.botId ?? null,
                  err: error instanceof Error ? error.message : String(error)
                },
                "Failed to deliver monitor progress update to Telegram"
              );
            });
        }
      }
    } finally {
      this.monitorProgressInFlight = false;
    }
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

  private parseReplyTarget(session: string): { chatId: string; botId?: string } {
    const separatorIndex = session.indexOf(":");
    if (separatorIndex <= 0) {
      return { chatId: session };
    }
    const candidateBotId = session.slice(0, separatorIndex);
    if (!/^\d+$/.test(candidateBotId)) {
      return { chatId: session };
    }
    return {
      botId: candidateBotId,
      chatId: session.slice(separatorIndex + 1)
    };
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

  private registerPushCallback(): void {
    this.paneBroadcaster.registerPushCallback((threadId: string, chunk: string) => {
      if (this.isRunActiveForThreadSafe(threadId) || this.isWithinRunCooldownSafe(threadId)) {
        return;
      }
      const subscribers = this.getPushSubscriptionsForThreadSafe(threadId);
      if (subscribers.length === 0) {
        return;
      }

      const accumulator = this.pushAccumulators.get(threadId);
      if (accumulator) {
        accumulator.chunks.push(chunk);
        clearTimeout(accumulator.timer);
        accumulator.timer = setTimeout(() => {
          void this.flushPushAccumulator(threadId);
        }, PUSH_DEBOUNCE_MS);
        accumulator.timer.unref();
        return;
      }

      const timer = setTimeout(() => {
        void this.flushPushAccumulator(threadId);
      }, PUSH_DEBOUNCE_MS);
      timer.unref();
      this.pushAccumulators.set(threadId, { chunks: [chunk], timer });
    });
  }

  private async flushPushAccumulator(threadId: string): Promise<void> {
    const accumulator = this.pushAccumulators.get(threadId);
    if (!accumulator) {
      return;
    }

    const combined = accumulator.chunks.join("");
    if (!combined.trim()) {
      this.pushAccumulators.delete(threadId);
      return;
    }

    const classification = classifyAgentOutput(combined);

    // Allow action_required (approval prompts) through even during active runs
    // so the user on the other client can respond to approvals.
    const runBlocked = this.isRunActiveForThreadSafe(threadId) || this.isWithinRunCooldownSafe(threadId);
    if (runBlocked && classification.kind !== "action_required") {
      this.pushAccumulators.delete(threadId);
      return;
    }

    this.pushAccumulators.delete(threadId);

    if (classification.kind === "transient") {
      return;
    }

    const subscribers = this.getPushSubscriptionsForThreadSafe(threadId);
    if (subscribers.length === 0) {
      return;
    }

    const traceId = randomUUID();
    const source = this.router.resolveSourceForThread(threadId);
    const normalizedText = classification.text.trim();
    const content = normalizedText.trim();
    if (!content) {
      return;
    }
    if (this.isDuplicatePushContent(threadId, content)) {
      return;
    }

    const result: HubResult = HubResultSchema.parse({
      trace_id: traceId,
      thread_id: threadId,
      source,
      status: "success",
      content,
      attachments: [],
      timestamp: new Date().toISOString()
    });

    this.recordAgentPushConversationSafe(threadId, content, traceId);

    for (const subscriber of subscribers) {
      await this.resultSender
        .sendResult(this.buildHistoryBackedResult(result), {
          channel: "telegram",
          chat_id: subscriber.chatId,
          bot_id: subscriber.botId
        })
        .catch((error) => {
          this.log.error(
            {
              trace_id: traceId,
              thread_id: threadId,
              target: subscriber.chatId,
              bot_id: subscriber.botId ?? null,
              err: error instanceof Error ? error.message : String(error)
            },
            "Failed to deliver push agent text to Telegram"
          );
        });
    }

    this.log.info(
      {
        trace_id: traceId,
        thread_id: threadId,
        kind: classification.kind,
        subscriber_count: subscribers.length
      },
      "Push agent text delivered"
    );
  }

  private getPushSubscriptionsForThreadSafe(threadId: string): PushDeliveryTarget[] {
    const candidate = this.router as unknown as {
      getPushSubscriptionsForThread?: (id: string) => Array<{ chatId: string; botId?: string }>;
    };
    const subscriptions = candidate.getPushSubscriptionsForThread?.(threadId) ?? [];
    return subscriptions.map((entry) => ({ threadId, chatId: entry.chatId, botId: entry.botId }));
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

  private recordAgentPushConversationSafe(threadId: string, content: string, traceId: string): void {
    const candidate = this.router as unknown as {
      recordAgentPushConversation?: (id: string, rawContent: string, traceId: string | null) => void;
    };
    candidate.recordAgentPushConversation?.(threadId, content, traceId);
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

  private isDuplicatePushContent(threadId: string, content: string): boolean {
    const nowMs = Date.now();
    const fingerprint = content.trim();
    const previous = this.lastPushDedupByThread.get(threadId);
    if (previous && previous.fingerprint === fingerprint && nowMs - previous.sentAtMs < PUSH_DEDUP_WINDOW_MS) {
      return true;
    }
    this.lastPushDedupByThread.set(threadId, { fingerprint, sentAtMs: nowMs });
    return false;
  }

  private clearPushAccumulators(): void {
    for (const accumulator of this.pushAccumulators.values()) {
      clearTimeout(accumulator.timer);
    }
    this.pushAccumulators.clear();
    this.lastPushDedupByThread.clear();
  }

  private async removeStaleSocket(): Promise<void> {
    await fs.promises.unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}
