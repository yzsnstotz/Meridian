import { config } from "../config";
import {
  AgentAPIClient,
  type AgentEvent,
  type AgentEventSubscription,
  type AgentStatus,
  type SseReconnectAttemptContext,
  type SseReconnectExhaustedContext
} from "../shared/agentapi-client";
import { AgentInstanceSchema, type AgentInstance } from "../types";
import { MonitorEventSchema, type MonitorEvent, type MonitorEventType, type MonitorMode } from "./events";
import { MonitorIpcReporter } from "./ipc-reporter";
import { getMonitorLogger } from "./logger";

interface MonitorAgentClient {
  connect: (socketPath: string) => Promise<void>;
  disconnect: () => void;
  subscribeEvents: (handler: (event: AgentEvent) => void) => AgentEventSubscription;
  getStatus: () => Promise<AgentStatus>;
}

interface MonitorClientCallbacks {
  onSseReconnectAttempt: (context: SseReconnectAttemptContext) => void;
  onSseReconnectExhausted: (context: SseReconnectExhaustedContext) => void;
}

type MonitorClientFactory = (
  instance: AgentInstance,
  callbacks: MonitorClientCallbacks
) => MonitorAgentClient;

interface MonitorReporter {
  report: (event: MonitorEvent) => Promise<void>;
}

interface MonitorTask {
  instance: AgentInstance;
  client: MonitorAgentClient;
  active: boolean;
  mode: MonitorMode;
  subscription: AgentEventSubscription | null;
  heartbeatTimer: NodeJS.Timeout | null;
  heartbeatInFlight: boolean;
  missedHeartbeats: number;
  lastStatus: string | null;
  sseReconnectCount: number;
  thresholdAlerted: boolean;
}

export interface MonitorManagerOptions {
  clientFactory?: MonitorClientFactory;
  reporter?: MonitorReporter;
  heartbeatIntervalMs?: number;
  heartbeatMissedThreshold?: number;
  maxSseReconnectAttempts?: number;
  now?: () => Date;
}

const DEFAULT_SSE_RECONNECT_ATTEMPTS = 3;

export class MonitorManager {
  private readonly log = getMonitorLogger();
  private readonly tasks = new Map<string, MonitorTask>();
  private readonly clientFactory: MonitorClientFactory;
  private readonly reporter: MonitorReporter;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatMissedThreshold: number;
  private readonly maxSseReconnectAttempts: number;
  private readonly now: () => Date;

  constructor(options: MonitorManagerOptions = {}) {
    this.reporter = options.reporter ?? new MonitorIpcReporter();
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? config.HEARTBEAT_INTERVAL_MS;
    this.heartbeatMissedThreshold =
      options.heartbeatMissedThreshold ?? config.HEARTBEAT_MISSED_THRESHOLD;
    this.maxSseReconnectAttempts =
      options.maxSseReconnectAttempts ?? DEFAULT_SSE_RECONNECT_ATTEMPTS;
    this.now = options.now ?? (() => new Date());
    this.clientFactory =
      options.clientFactory ??
      ((instance, callbacks) => {
        return new AgentAPIClient({
          threadId: instance.thread_id,
          maxReconnectAttempts: this.maxSseReconnectAttempts,
          onSseReconnectAttempt: callbacks.onSseReconnectAttempt,
          onSseReconnectExhausted: callbacks.onSseReconnectExhausted
        });
      });
  }

  register(instanceInput: AgentInstance): void {
    const instance = AgentInstanceSchema.parse(instanceInput);
    this.unregister(instance.thread_id);

    let task: MonitorTask;
    const callbacks: MonitorClientCallbacks = {
      onSseReconnectAttempt: (context) => {
        if (!task.active) {
          return;
        }
        task.sseReconnectCount = context.attempt;
      },
      onSseReconnectExhausted: (context) => {
        if (!task.active) {
          return;
        }
        task.sseReconnectCount = context.attempts;
        void this.switchToHeartbeat(task, "SSE reconnect attempts exhausted", context.errorSummary);
      }
    };

    const client = this.clientFactory(instance, callbacks);
    task = {
      instance,
      client,
      active: true,
      mode: "sse_hook",
      subscription: null,
      heartbeatTimer: null,
      heartbeatInFlight: false,
      missedHeartbeats: 0,
      lastStatus: null,
      sseReconnectCount: 0,
      thresholdAlerted: false
    };

    this.tasks.set(instance.thread_id, task);
    this.log.info(
      {
        trace_id: null,
        thread_id: instance.thread_id,
        monitor_mode: task.mode,
        socket_path: instance.socket_path
      },
      "Monitor task registered"
    );

    void this.startTask(task);
  }

  unregister(threadId: string): void {
    const task = this.tasks.get(threadId);
    if (!task) {
      return;
    }

    task.active = false;
    task.subscription?.close();
    task.subscription = null;

    if (task.heartbeatTimer) {
      clearInterval(task.heartbeatTimer);
      task.heartbeatTimer = null;
    }

    task.client.disconnect();
    this.tasks.delete(threadId);

    this.log.info(
      {
        trace_id: null,
        thread_id: threadId
      },
      "Monitor task unregistered"
    );
  }

  shutdown(): void {
    for (const threadId of this.tasks.keys()) {
      this.unregister(threadId);
    }
  }

  private async startTask(task: MonitorTask): Promise<void> {
    try {
      await task.client.connect(task.instance.socket_path);
      this.startSseSubscription(task);
    } catch (error) {
      if (!task.active) {
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error(
        {
          trace_id: null,
          thread_id: task.instance.thread_id,
          monitor_mode: task.mode,
          socket_path: task.instance.socket_path,
          err: errorMessage
        },
        "Failed to start monitor task"
      );
      await this.emitEvent(task, "agent_error", {
        error: errorMessage,
        details: {
          reason: "monitor_connect_failed"
        }
      });
    }
  }

  private startSseSubscription(task: MonitorTask): void {
    if (!task.active) {
      return;
    }

    if (task.heartbeatTimer) {
      clearInterval(task.heartbeatTimer);
      task.heartbeatTimer = null;
    }

    task.mode = "sse_hook";
    task.missedHeartbeats = 0;
    task.thresholdAlerted = false;
    task.subscription?.close();
    task.subscription = null;

    try {
      task.subscription = task.client.subscribeEvents((event) => {
        void this.handleSseEvent(task, event);
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      void this.switchToHeartbeat(task, "Failed to subscribe SSE stream", errorMessage);
      return;
    }

    this.log.info(
      {
        trace_id: null,
        thread_id: task.instance.thread_id,
        monitor_mode: task.mode
      },
      "SSE monitor subscription started"
    );
  }

  private async switchToHeartbeat(task: MonitorTask, reason: string, errorMessage?: string): Promise<void> {
    if (!task.active || task.mode === "heartbeat") {
      return;
    }

    task.subscription?.close();
    task.subscription = null;
    task.mode = "heartbeat";
    task.missedHeartbeats = 0;
    task.thresholdAlerted = false;

    this.log.warn(
      {
        trace_id: null,
        thread_id: task.instance.thread_id,
        monitor_mode: task.mode,
        reason,
        err: errorMessage,
        sse_reconnect_count: task.sseReconnectCount
      },
      "Switching monitor mode from SSE to heartbeat"
    );

    if (errorMessage) {
      await this.emitEvent(task, "agent_error", {
        error: errorMessage,
        details: {
          reason: "sse_exhausted"
        }
      });
    }

    task.heartbeatTimer = setInterval(() => {
      void this.runHeartbeatTick(task);
    }, this.heartbeatIntervalMs);
    void this.runHeartbeatTick(task);
  }

  private async handleSseEvent(task: MonitorTask, event: AgentEvent): Promise<void> {
    if (!task.active) {
      return;
    }

    task.sseReconnectCount = 0;
    const data = this.asRecord(event.data);
    const explicitType = this.extractEventType(event, data);
    const status = this.extractStatus(data);

    if (status && status !== task.lastStatus) {
      const previousStatus = task.lastStatus;
      task.lastStatus = status;
      await this.emitEvent(task, "status_changed", {
        agent_status: status,
        details: {
          previous_status: previousStatus,
          next_status: status
        }
      });
    }

    if (explicitType) {
      await this.emitEvent(task, explicitType, {
        agent_status: status ?? task.lastStatus ?? undefined,
        details: data ?? undefined
      });
      return;
    }

    if (this.isTaskCompletedEvent(event, data)) {
      await this.emitEvent(task, "task_completed", {
        agent_status: status ?? task.lastStatus ?? undefined,
        details: data ?? undefined
      });
    }

    if (status === "error") {
      await this.emitEvent(task, "agent_error", {
        agent_status: status,
        details: data ?? undefined
      });
    }
  }

  private async runHeartbeatTick(task: MonitorTask): Promise<void> {
    if (!task.active || task.mode !== "heartbeat" || task.heartbeatInFlight) {
      return;
    }

    task.heartbeatInFlight = true;
    try {
      const statusResponse = await task.client.getStatus();
      task.missedHeartbeats = 0;

      const status = typeof statusResponse.status === "string" ? statusResponse.status : "unknown";
      if (status !== task.lastStatus) {
        const previousStatus = task.lastStatus;
        task.lastStatus = status;
        await this.emitEvent(task, "status_changed", {
          agent_status: status,
          details: {
            previous_status: previousStatus,
            next_status: status
          }
        });
      }

      if (status === "error") {
        await this.emitEvent(task, "agent_error", {
          agent_status: status,
          details: {
            reason: "heartbeat_status_error"
          }
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      task.missedHeartbeats += 1;
      await this.emitEvent(task, "heartbeat_missed", {
        missed_heartbeats: task.missedHeartbeats,
        error: errorMessage
      });

      if (task.missedHeartbeats >= this.heartbeatMissedThreshold && !task.thresholdAlerted) {
        task.thresholdAlerted = true;
        await this.emitEvent(task, "agent_error", {
          error: `Heartbeat missed ${task.missedHeartbeats} consecutive checks`,
          missed_heartbeats: task.missedHeartbeats,
          details: {
            reason: "heartbeat_threshold_exceeded"
          }
        });
      }
    } finally {
      task.heartbeatInFlight = false;
    }
  }

  private async emitEvent(
    task: MonitorTask,
    eventType: MonitorEventType,
    fields: Partial<MonitorEvent> = {}
  ): Promise<void> {
    if (!task.active) {
      return;
    }

    const event = MonitorEventSchema.parse({
      trace_id: null,
      thread_id: task.instance.thread_id,
      event_type: eventType,
      monitor_mode: task.mode,
      timestamp: this.now().toISOString(),
      agent_status: fields.agent_status ?? task.lastStatus ?? undefined,
      missed_heartbeats: fields.missed_heartbeats,
      sse_reconnect_count: task.sseReconnectCount > 0 ? task.sseReconnectCount : undefined,
      details: fields.details,
      error: fields.error
    });

    const severity = this.resolveSeverity(eventType);
    this.log[severity](
      {
        trace_id: event.trace_id,
        thread_id: event.thread_id,
        monitor_mode: event.monitor_mode,
        event_type: event.event_type,
        agent_status: event.agent_status,
        missed_heartbeats: event.missed_heartbeats,
        sse_reconnect_count: event.sse_reconnect_count,
        details: event.details,
        err: event.error
      },
      "Monitor event emitted"
    );

    try {
      await this.reporter.report(event);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error(
        {
          trace_id: event.trace_id,
          thread_id: event.thread_id,
          event_type: event.event_type,
          monitor_mode: event.monitor_mode,
          err: errorMessage
        },
        "Monitor event reporting failed after retries"
      );
    }
  }

  private resolveSeverity(eventType: MonitorEventType): "info" | "warn" | "error" {
    if (eventType === "heartbeat_missed") {
      return "warn";
    }
    if (eventType === "agent_error") {
      return "error";
    }
    return "info";
  }

  private extractEventType(
    event: AgentEvent,
    data: Record<string, unknown> | null
  ): MonitorEventType | null {
    const candidates: unknown[] = [event.type, data?.event_type, data?.type];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        continue;
      }

      const normalized = candidate.trim().toLowerCase();
      const parsed = MonitorEventSchema.shape.event_type.safeParse(normalized);
      if (parsed.success) {
        return parsed.data;
      }
    }
    return null;
  }

  private extractStatus(data: Record<string, unknown> | null): string | null {
    const statusCandidate = data?.status;
    if (typeof statusCandidate === "string" && statusCandidate.trim().length > 0) {
      return statusCandidate.trim().toLowerCase();
    }
    return null;
  }

  private isTaskCompletedEvent(event: AgentEvent, data: Record<string, unknown> | null): boolean {
    const typeCandidates: unknown[] = [event.type, data?.event_type, data?.type];
    for (const candidate of typeCandidates) {
      if (typeof candidate !== "string") {
        continue;
      }

      const normalized = candidate.trim().toLowerCase();
      if (
        normalized === "done" ||
        normalized === "completed" ||
        normalized === "task_complete" ||
        normalized === "task_completed"
      ) {
        return true;
      }
    }

    return data?.completed === true;
  }

  private asRecord(data: unknown): Record<string, unknown> | null {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }
    return data as Record<string, unknown>;
  }
}
