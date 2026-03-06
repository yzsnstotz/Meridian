import fs from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";

import { config } from "../config";
import { createLogger } from "../logger";
import { MonitorEventSchema, type MonitorEvent } from "../monitor/events";
import {
  AgentTypeSchema,
  HubMessageSchema,
  HubResultSchema,
  InboundUIEventSchema,
  type AgentType,
  type HubMessage,
  type HubResult
} from "../types";
import { normalizeInboundEvent } from "./normalizer";
import { ResultSender } from "./result-sender";
import { InstanceRegistry } from "./registry";
import { HubRouter, type MonitorUpdateDispatch } from "./router";

interface InboundEnvelope {
  chatId?: string;
  chat_id?: string;
  event: unknown;
}

export interface HubServerOptions {
  socketPath?: string;
  router?: HubRouter;
  resultSender?: ResultSender;
}

export class HubServer {
  private readonly log = createLogger("hub");
  private readonly socketPath: string;
  private readonly router: HubRouter;
  private readonly resultSender: ResultSender;
  private server: net.Server | null = null;
  private monitorProgressTimer: NodeJS.Timeout | null = null;
  private monitorProgressInFlight = false;

  constructor(options: HubServerOptions = {}) {
    this.socketPath = options.socketPath ?? config.HUB_SOCKET_PATH;
    this.router = options.router ?? new HubRouter(new InstanceRegistry());
    this.resultSender = options.resultSender ?? new ResultSender();
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    await this.removeStaleSocket();
    await this.router.initialize();

    this.server = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.setEncoding("utf8");
      let raw = "";

      socket.on("data", (chunk: string) => {
        raw += chunk;
      });

      socket.on("end", () => {
        void this.handleRawPayload(raw)
          .then((result) => {
            if (!socket.writable) {
              return;
            }
            if (result) {
              socket.end(JSON.stringify(result));
              return;
            }
            socket.end();
          })
          .catch((error) => {
            this.log.error({ trace_id: null, thread_id: null, err: String(error) }, "Hub socket response failed");
            if (socket.writable) {
              socket.end();
            }
          });
      });

      socket.on("error", (error) => {
        this.log.error({ trace_id: null, thread_id: null, err: String(error) }, "Hub socket connection failed");
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, () => resolve());
    });

    this.startMonitorProgressTicker();

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
    await fs.promises.unlink(this.socketPath).catch(() => undefined);
    this.log.info({ trace_id: null, thread_id: null, socket_path: this.socketPath }, "Hub server stopped");
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
      const result = await this.router.route(message);
      const validatedResult = HubResultSchema.parse(result);
      if (!message.suppress_reply) {
        await this.resultSender.sendResult(validatedResult, message.reply_channel);
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

    const sessionTargets = this.router.getAttachedSessionsForThread(event.thread_id);
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
    const sessionTargets = this.collectMonitorCompletionTargets(event.thread_id);
    if (sessionTargets.length === 0) {
      this.log.warn(
        {
          trace_id: event.trace_id,
          thread_id: event.thread_id,
          event_type: event.event_type
        },
        "Monitor completion skipped because no recipient is registered for thread"
      );
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

    for (const sessionTarget of sessionTargets) {
      const replyTarget = this.parseReplyTarget(sessionTarget);
      await this.resultSender
        .sendResult(completionResult, {
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

    if (event.agent_status) {
      lines.push(`agent_status=${event.agent_status}`);
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

        for (const target of targets) {
          await this.resultSender
            .sendResult(progressResult, {
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

  private async removeStaleSocket(): Promise<void> {
    await fs.promises.unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}
