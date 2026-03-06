import { randomUUID } from "node:crypto";

import { config } from "../config";
import { createLogger } from "../logger";
import { AgentAPIClient } from "../shared/agentapi-client";
import {
  AgentInstanceStatusSchema,
  AgentTypeSchema,
  HubMessageSchema,
  HubResultSchema,
  type AgentInstance,
  type AgentType,
  type HubMessage,
  type HubResult
} from "../types";
import { InstanceManager } from "./instance-manager";
import { InstanceRegistry } from "./registry";
import { loadPersistedHubState, savePersistedHubState } from "./state-store";

interface AgentClient {
  connect: (socketPath: string) => Promise<void>;
  disconnect: () => void;
  sendMessage: (content: string, attachments: HubMessage["payload"]["attachments"]) => Promise<Record<string, unknown>>;
  getStatus: () => Promise<Record<string, unknown>>;
  getMessages?: () => Promise<Record<string, unknown>[]>;
}

interface AgentMessageSnapshot {
  id: number;
  content: string;
}

interface MonitorUpdateSubscription {
  sessionId: string;
  chatId: string;
  botId?: string;
  intervalMs: number;
  nextDispatchAtMs: number;
}

export interface MonitorUpdateDispatch {
  threadId: string;
  chatId: string;
  botId?: string;
}

const LIVE_INSTANCE_STATUSES = new Set<AgentInstance["status"]>(["idle", "running", "waiting"]);

function encodeSessionId(chatId: string, botId: string | undefined): string {
  return botId ? `${botId}:${chatId}` : chatId;
}

export interface HubRouterOptions {
  clientFactory?: (threadId: string) => AgentClient;
  instanceManager?: InstanceManager;
  now?: () => Date;
  statePath?: string;
}

function resolveSourceFromTarget(target: string): AgentType {
  const candidate = AgentTypeSchema.safeParse(target);
  if (candidate.success) {
    return candidate.data;
  }
  return "codex";
}

export class HubRouter {
  private readonly log = createLogger("hub");
  private readonly clientFactory: (threadId: string) => AgentClient;
  private readonly instanceManager: InstanceManager;
  private readonly now: () => Date;
  private readonly statePath: string;
  private readonly monitorUpdateSubscriptionsByThread = new Map<string, Map<string, MonitorUpdateSubscription>>();

  constructor(
    private readonly registry: InstanceRegistry,
    options: HubRouterOptions = {}
  ) {
    this.clientFactory =
      options.clientFactory ??
      ((threadId: string) => {
        return new AgentAPIClient({ threadId });
      });
    this.instanceManager = options.instanceManager ?? new InstanceManager(this.registry);
    this.now = options.now ?? (() => new Date());
    this.statePath = options.statePath ?? config.MERIDIAN_STATE_PATH;
  }

  async initialize(): Promise<void> {
    const persistedState = loadPersistedHubState(this.statePath, this.now().toISOString());
    const result = await this.instanceManager.rehydrateFromState(persistedState);
    this.persistStateSafely();
    this.log.info(
      {
        trace_id: null,
        thread_id: null,
        state_path: this.statePath,
        restored_threads: result.restored_thread_ids,
        pruned_threads: result.pruned_thread_ids
      },
      "Hub router state initialized"
    );
  }

  async route(rawMessage: HubMessage): Promise<HubResult> {
    const message = HubMessageSchema.parse(rawMessage);
    const startedAt = Date.now();
    this.log.info(
      {
        trace_id: message.trace_id,
        thread_id: message.thread_id,
        actor_id: message.actor_id,
        intent: message.intent,
        target: message.target,
        dispatch_status: "ok"
      },
      "Routing HubMessage"
    );

    try {
      const result = await this.routeByIntent(message);
      this.persistStateSafely();
      const latencyMs = Date.now() - startedAt;
      this.log.info(
        {
          trace_id: message.trace_id,
          thread_id: message.thread_id,
          actor_id: message.actor_id,
          intent: message.intent,
          target: message.target,
          dispatch_status: "ok",
          result_status: result.status,
          status: result.status,
          latency_ms: latencyMs
        },
        "Hub routing complete"
      );
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const latencyMs = Date.now() - startedAt;
      this.log.error(
        {
          trace_id: message.trace_id,
          thread_id: message.thread_id,
          actor_id: message.actor_id,
          intent: message.intent,
          target: message.target,
          dispatch_status: "failed",
          result_status: "error",
          latency_ms: latencyMs,
          err: errorMessage
        },
        "Hub routing failed"
      );
      this.persistStateSafely();
      return this.buildResult(
        message,
        "error",
        this.resolveResultSource(message),
        `Routing failed: ${errorMessage}`
      );
    }
  }

  private async routeByIntent(message: HubMessage): Promise<HubResult> {
    switch (message.intent) {
      case "run":
        return await this.handleRun(message);
      case "terminal_input":
        return this.handleTerminalInput(message);
      case "status":
        return await this.handleStatus(message);
      case "list":
        return this.handleList(message);
      case "spawn":
        return await this.handleSpawn(message);
      case "restart":
        return await this.handleRestart(message);
      case "kill":
        return await this.handleKill(message);
      case "attach":
        return this.handleAttach(message);
      case "switch_model":
        return await this.handleSwitchModel(message);
      case "monitor_update":
        return this.handleMonitorUpdate(message);
      case "monitor_manual_update":
        return await this.handleManualMonitorUpdate(message);
      default:
        return this.buildResult(message, "error", this.resolveResultSource(message), "Unsupported intent");
    }
  }

  private async handleRun(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const client = this.clientFactory(instance.thread_id);
    await client.connect(instance.socket_path);

    try {
      const previousSnapshot = await this.getLatestAgentMessageSnapshot(client);
      const response = await client.sendMessage(message.payload.content, message.payload.attachments);
      this.registry.setStatus(instance.thread_id, "running");
      const agentReply = await this.waitForAgentReply(client, previousSnapshot);
      const content = this.formatRunContent(
        instance.thread_id,
        agentReply ?? (await this.resolveFallbackRunContent(client, response))
      );
      return this.buildResult(
        message,
        "success",
        instance.agent_type,
        content,
        instance.thread_id
      );
    } finally {
      client.disconnect();
    }
  }

  private handleTerminalInput(message: HubMessage): HubResult {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const content = this.instanceManager.sendTerminalInput(threadId, message.payload.content);
    return this.buildResult(message, "success", instance.agent_type, content, threadId);
  }

  private async handleStatus(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadId(message);
    const status = await this.instanceManager.status(threadId);
    return this.buildResult(
      message,
      "success",
      status.instance.agent_type,
      JSON.stringify(status, null, 2),
      status.instance.thread_id
    );
  }

  private handleList(message: HubMessage): HubResult {
    const requestSessionId = encodeSessionId(message.reply_channel.chat_id, message.reply_channel.bot_id);
    const instances = this.instanceManager
      .list()
      .filter((instance) => LIVE_INSTANCE_STATUSES.has(instance.status));
    const listedInstances = instances.map((instance) => {
      const attachment = this.instanceManager.getThreadAttachment(instance.thread_id);
      const attachable = this.instanceManager.isThreadAttachableBySession(instance.thread_id, requestSessionId);
      return {
        ...instance,
        attached: attachment.sessions.length > 0,
        attached_sessions: attachment.sessions,
        attached_interface: attachment.interface_id,
        attachable
      };
    });
    const content = listedInstances.length === 0 ? "No active agent instances." : JSON.stringify(listedInstances, null, 2);
    return this.buildResult(message, "success", this.resolveResultSource(message), content);
  }

  private async handleSpawn(message: HubMessage): Promise<HubResult> {
    const type = AgentTypeSchema.parse(message.target);
    const spawnDir = message.payload.spawn_dir?.trim() || undefined;
    const threadId = await this.instanceManager.spawn(type, message.mode, spawnDir);
    const sessionId = encodeSessionId(message.reply_channel.chat_id, message.reply_channel.bot_id);
    this.instanceManager.attach(threadId, sessionId);
    const spawned = this.registry.get(threadId);
    const content =
      spawned === undefined
        ? `Spawned ${type} instance: ${threadId}`
        : JSON.stringify({ thread_id: threadId, instance: spawned }, null, 2);
    return this.buildResult(message, "success", type, content, threadId);
  }

  private async handleKill(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    await this.instanceManager.kill(threadId);
    return this.buildResult(
      message,
      "success",
      instance.agent_type,
      `Agent instance ${threadId} killed`,
      threadId
    );
  }

  private async handleRestart(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const restartedThreadId = await this.instanceManager.restart(threadId);
    const restarted = this.registry.get(restartedThreadId);
    const content =
      restarted === undefined
        ? `Restarted ${threadId}`
        : JSON.stringify({ thread_id: restartedThreadId, instance: restarted }, null, 2);
    return this.buildResult(message, "success", instance.agent_type, content, restartedThreadId);
  }

  private handleAttach(message: HubMessage): HubResult {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const sessionId = encodeSessionId(message.reply_channel.chat_id, message.reply_channel.bot_id);
    const binding = this.instanceManager.attach(threadId, sessionId);
    const content = JSON.stringify(binding, null, 2);
    return this.buildResult(message, "success", instance.agent_type, content, threadId);
  }

  private async handleSwitchModel(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadIdFromThread(message);
    this.resolveInstance(threadId);
    const nextType = AgentTypeSchema.parse(message.target);
    const switchedThreadId = await this.instanceManager.switchModel(threadId, nextType);
    const switched = this.registry.get(switchedThreadId);
    const content =
      switched === undefined
        ? `Switched ${threadId} to ${nextType}`
        : JSON.stringify({ thread_id: switchedThreadId, instance: switched }, null, 2);
    return this.buildResult(message, "success", nextType, content, switchedThreadId);
  }

  private handleMonitorUpdate(message: HubMessage): HubResult {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const chatId = message.reply_channel.chat_id;
    const botId = message.reply_channel.bot_id;
    const sessionId = encodeSessionId(chatId, botId);
    const requestedIntervalSec = message.payload.monitor_updates_interval_sec;
    const requestedEnabled = message.payload.monitor_updates_enabled;
    const inferredEnabled = requestedEnabled ?? (requestedIntervalSec !== undefined ? true : undefined);
    const existing = this.monitorUpdateSubscriptionsByThread.get(threadId)?.get(sessionId) ?? null;

    if (inferredEnabled === undefined) {
      if (!existing) {
        return this.buildResult(
          message,
          "success",
          instance.agent_type,
          `Monitor updates are OFF for thread=${threadId} chat=${chatId}.`,
          threadId
        );
      }
      return this.buildResult(
        message,
        "success",
        instance.agent_type,
        `Monitor updates are ON for thread=${threadId} chat=${chatId} interval=${Math.floor(existing.intervalMs / 1000)}s.`,
        threadId
      );
    }

    if (!inferredEnabled) {
      this.deleteMonitorUpdateSubscription(threadId, sessionId);
      return this.buildResult(
        message,
        "success",
        instance.agent_type,
        `Monitor updates turned OFF for thread=${threadId} chat=${chatId}.`,
        threadId
      );
    }

    const existingIntervalSec = existing ? Math.floor(existing.intervalMs / 1000) : undefined;
    const normalizedIntervalSec = this.normalizeMonitorUpdateIntervalSec(
      requestedIntervalSec ?? existingIntervalSec
    );
    this.upsertMonitorUpdateSubscription(threadId, sessionId, chatId, botId, normalizedIntervalSec);
    return this.buildResult(
      message,
      "success",
      instance.agent_type,
      `Monitor updates turned ON for thread=${threadId} chat=${chatId} interval=${normalizedIntervalSec}s.`,
      threadId
    );
  }

  private async handleManualMonitorUpdate(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadId(message);
    return await this.buildProgressResultForThread(threadId, message.trace_id);
  }

  private resolveInstance(threadId: string): AgentInstance {
    const instance = this.registry.get(threadId);
    if (!instance) {
      throw new Error(`No registered agent instance found for thread_id=${threadId}`);
    }
    return instance;
  }

  private resolveThreadId(message: HubMessage): string {
    const explicitThread = this.extractConcreteThreadId(message.target) ?? this.extractConcreteThreadId(message.thread_id);
    if (explicitThread) {
      return explicitThread;
    }

    const sessionId = encodeSessionId(message.reply_channel.chat_id, message.reply_channel.bot_id);
    const attachedThread = this.instanceManager.getAttachedThread(sessionId);
    if (attachedThread) {
      return attachedThread;
    }

    throw new Error(`No thread is attached for session=${message.reply_channel.chat_id}`);
  }

  private resolveThreadIdFromThread(message: HubMessage): string {
    const explicitThread = this.extractConcreteThreadId(message.thread_id);
    if (explicitThread) {
      return explicitThread;
    }

    const sessionId = encodeSessionId(message.reply_channel.chat_id, message.reply_channel.bot_id);
    const attachedThread = this.instanceManager.getAttachedThread(sessionId);
    if (attachedThread) {
      return attachedThread;
    }

    throw new Error(`No thread is attached for session=${message.reply_channel.chat_id}`);
  }

  private extractConcreteThreadId(candidate: string): string | null {
    const normalized = candidate.trim();
    if (!normalized) {
      return null;
    }

    if (normalized === "active" || normalized === "all" || normalized === "global" || normalized === "pending" || normalized === "unbound") {
      return null;
    }

    return normalized;
  }

  private resolveResultSource(message: HubMessage): AgentType {
    const threadId = this.extractConcreteThreadId(message.thread_id);
    if (threadId && this.registry.has(threadId)) {
      const threadInstance = this.registry.get(threadId);
      if (threadInstance) {
        return threadInstance.agent_type;
      }
    }

    const targetThread = this.extractConcreteThreadId(message.target);
    if (targetThread && this.registry.has(targetThread)) {
      const targetInstance = this.registry.get(targetThread);
      if (targetInstance) {
        return targetInstance.agent_type;
      }
    }

    return resolveSourceFromTarget(message.target);
  }

  resolveSourceForThread(threadId: string): AgentType {
    return this.registry.get(threadId)?.agent_type ?? "codex";
  }

  async buildCompletionResultForThread(threadId: string, traceId: string | null): Promise<HubResult> {
    const instance = this.resolveInstance(threadId);
    const client = this.clientFactory(instance.thread_id);
    await client.connect(instance.socket_path);

    try {
      const content = await this.resolveCompletionContent(client, threadId);
      return HubResultSchema.parse({
        trace_id: traceId ?? randomUUID(),
        thread_id: threadId,
        source: instance.agent_type,
        status: "success",
        content,
        attachments: [],
        timestamp: this.now().toISOString()
      });
    } finally {
      client.disconnect();
    }
  }

  async buildProgressResultForThread(threadId: string, traceId: string | null): Promise<HubResult> {
    const instance = this.resolveInstance(threadId);
    const client = this.clientFactory(instance.thread_id);
    await client.connect(instance.socket_path);

    try {
      const content = await this.resolveProgressContent(client, threadId);
      return HubResultSchema.parse({
        trace_id: traceId ?? randomUUID(),
        thread_id: threadId,
        source: instance.agent_type,
        status: "partial",
        content,
        attachments: [],
        timestamp: this.now().toISOString()
      });
    } finally {
      client.disconnect();
    }
  }

  setInstanceStatus(threadId: string, status: string): void {
    const normalizedStatus = this.normalizeMonitorStatus(status);
    if (!normalizedStatus) {
      return;
    }
    const parsed = AgentInstanceStatusSchema.safeParse(normalizedStatus);
    if (!parsed.success) {
      return;
    }
    this.registry.setStatus(threadId, parsed.data);
    this.persistStateSafely();
  }

  getAttachedSessionsForThread(threadId: string): string[] {
    return this.instanceManager.getSessionsForThread(threadId);
  }

  getMonitorUpdateSubscribersForThread(threadId: string): string[] {
    const subscriptions = this.monitorUpdateSubscriptionsByThread.get(threadId);
    if (!subscriptions) {
      return [];
    }
    return [...subscriptions.keys()];
  }

  collectDueMonitorUpdateDispatches(nowMs = Date.now()): MonitorUpdateDispatch[] {
    const due: MonitorUpdateDispatch[] = [];
    for (const [threadId, subscriptions] of this.monitorUpdateSubscriptionsByThread.entries()) {
      const status = this.registry.get(threadId)?.status;
      if (status !== "running") {
        continue;
      }

      for (const subscription of subscriptions.values()) {
        if (subscription.nextDispatchAtMs > nowMs) {
          continue;
        }
        subscription.nextDispatchAtMs = nowMs + subscription.intervalMs;
        due.push({
          threadId,
          chatId: subscription.chatId,
          botId: subscription.botId
        });
      }
    }
    return due;
  }

  forceMonitorUpdateDispatchNow(threadId: string, nowMs = Date.now()): void {
    const subscriptions = this.monitorUpdateSubscriptionsByThread.get(threadId);
    if (!subscriptions) {
      return;
    }
    for (const subscription of subscriptions.values()) {
      subscription.nextDispatchAtMs = nowMs;
    }
  }

  isThreadRunning(threadId: string): boolean {
    return this.registry.get(threadId)?.status === "running";
  }

  private extractContent(response: Record<string, unknown>): string {
    const content = response.content;
    if (typeof content === "string" && content.trim().length > 0) {
      return content;
    }

    const message = response.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }

    return JSON.stringify(response, null, 2);
  }

  private async resolveCompletionContent(client: AgentClient, threadId: string): Promise<string> {
    if (!client.getMessages) {
      return this.formatRunContent(threadId, "Task completed.");
    }

    try {
      const messages = await client.getMessages();
      const snapshots = this.extractAgentMessageSnapshots(messages);
      const latest = this.pickLatestStableSnapshot(snapshots);
      if (latest) {
        return this.formatRunContent(threadId, latest.content);
      }
    } catch {
      // Best effort only; monitor completion still returns an explicit result.
    }

    return this.formatRunContent(threadId, "Task completed.");
  }

  private async resolveProgressContent(client: AgentClient, threadId: string): Promise<string> {
    if (!client.getMessages) {
      return this.formatRunContent(threadId, "Task is running...");
    }

    try {
      const messages = await client.getMessages();
      const snapshots = this.extractAgentMessageSnapshots(messages);
      const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] ?? null : null;
      if (latest) {
        return this.formatRunContent(threadId, latest.content);
      }
    } catch {
      // Best effort only; interval updates continue on the next tick.
    }

    return this.formatRunContent(threadId, "Task is running...");
  }

  private pickLatestStableSnapshot(snapshots: AgentMessageSnapshot[]): AgentMessageSnapshot | null {
    for (let index = snapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = snapshots[index];
      if (!snapshot) {
        continue;
      }
      if (!this.isTransientTerminalFrame(snapshot.content)) {
        return snapshot;
      }
    }

    return snapshots.length > 0 ? (snapshots[snapshots.length - 1] ?? null) : null;
  }

  private normalizeMonitorStatus(status: string): AgentInstance["status"] | null {
    const normalized = status.trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    if (normalized === "stable" || normalized === "done" || normalized === "completed") {
      return "waiting";
    }

    if (
      normalized === "idle" ||
      normalized === "running" ||
      normalized === "waiting" ||
      normalized === "stopped" ||
      normalized === "error"
    ) {
      return normalized;
    }

    return null;
  }

  private upsertMonitorUpdateSubscription(
    threadId: string,
    sessionId: string,
    chatId: string,
    botId: string | undefined,
    intervalSec: number
  ): void {
    let byChat = this.monitorUpdateSubscriptionsByThread.get(threadId);
    if (!byChat) {
      byChat = new Map<string, MonitorUpdateSubscription>();
      this.monitorUpdateSubscriptionsByThread.set(threadId, byChat);
    }

    byChat.set(sessionId, {
      sessionId,
      chatId,
      botId,
      intervalMs: intervalSec * 1000,
      nextDispatchAtMs: this.now().getTime()
    });
  }

  private deleteMonitorUpdateSubscription(threadId: string, sessionId: string): void {
    const byChat = this.monitorUpdateSubscriptionsByThread.get(threadId);
    if (!byChat) {
      return;
    }

    byChat.delete(sessionId);
    if (byChat.size === 0) {
      this.monitorUpdateSubscriptionsByThread.delete(threadId);
    }
  }

  private normalizeMonitorUpdateIntervalSec(candidate: number | undefined): number {
    const fallback = config.MONITOR_UPDATE_DEFAULT_INTERVAL_SEC;
    const raw = candidate ?? fallback;
    const normalized = Math.floor(raw);
    if (!Number.isFinite(normalized) || normalized <= 0) {
      throw new Error("Monitor update interval must be a positive integer (seconds)");
    }
    if (normalized < config.MONITOR_UPDATE_MIN_INTERVAL_SEC || normalized > config.MONITOR_UPDATE_MAX_INTERVAL_SEC) {
      throw new Error(
        `Monitor update interval must be between ${config.MONITOR_UPDATE_MIN_INTERVAL_SEC} and ${config.MONITOR_UPDATE_MAX_INTERVAL_SEC} seconds`
      );
    }
    return normalized;
  }

  private async getLatestAgentMessageSnapshot(client: AgentClient): Promise<AgentMessageSnapshot | null> {
    if (!client.getMessages) {
      return null;
    }

    try {
      const messages = await client.getMessages();
      const snapshots = this.extractAgentMessageSnapshots(messages);
      return snapshots.length > 0 ? snapshots[snapshots.length - 1] ?? null : null;
    } catch {
      return null;
    }
  }

  private async waitForAgentReply(
    client: AgentClient,
    previousSnapshot: AgentMessageSnapshot | null
  ): Promise<string | null> {
    if (!client.getMessages) {
      return null;
    }

    const maxAttempts = 40;
    const delayMs = 500;
    let candidate: string | null = null;
    let candidateTail: string | null = null;
    let stablePolls = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const messages = await client.getMessages();
        const snapshots = this.extractAgentMessageSnapshots(messages);
        const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] ?? null : null;
        const combinedReply = this.combineNewAgentReplySnapshots(snapshots, previousSnapshot);

        if (latest && combinedReply && this.isNewAgentReply(latest, previousSnapshot)) {
          const changedCandidate = candidate !== combinedReply;
          if (changedCandidate) {
            candidate = combinedReply;
            candidateTail = latest.content;
            stablePolls = 0;
          } else {
            stablePolls += 1;
          }

          if (candidate && candidateTail && !this.isTransientTerminalFrame(candidateTail) && stablePolls >= 2) {
            return candidate;
          }
        }
      } catch {
        return null;
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }

    if (candidate && candidateTail && !this.isTransientTerminalFrame(candidateTail)) {
      return candidate;
    }

    return candidate;
  }

  private async resolveFallbackRunContent(
    client: AgentClient,
    response: Record<string, unknown>
  ): Promise<string> {
    const extracted = this.extractContent(response);
    if (extracted.trim().length > 0 && !this.isTransportAckResponse(response)) {
      return extracted;
    }

    const latestSnapshot = await this.getLatestAgentMessageSnapshot(client);
    if (latestSnapshot?.content) {
      if (this.isTransientTerminalFrame(latestSnapshot.content)) {
        return extracted;
      }
      return latestSnapshot.content;
    }

    return extracted;
  }

  private isTransportAckResponse(response: Record<string, unknown>): boolean {
    const ok = response.ok;
    const content = response.content;
    const message = response.message;
    return ok === true && typeof content !== "string" && typeof message !== "string";
  }

  private isNewAgentReply(
    latest: AgentMessageSnapshot,
    previous: AgentMessageSnapshot | null
  ): boolean {
    if (!previous) {
      return true;
    }

    return latest.id > previous.id || latest.content !== previous.content;
  }

  private isTransientTerminalFrame(content: string): boolean {
    const normalized = content.toLowerCase();
    const hints = [
      "waiting for auth",
      "do you trust the files in this folder",
      "gemini cli is restarting to apply the trust changes",
      "skip the next speaker check for faster responses",
      "see full, untruncated responses",
      "let node.js auto-configure memory",
      "(esc to cancel"
    ];

    for (const hint of hints) {
      if (normalized.includes(hint)) {
        return true;
      }
    }

    if (/[\u2800-\u28ff]/.test(content) && normalized.includes("esc to cancel")) {
      return true;
    }

    return false;
  }

  private extractAgentMessageSnapshots(
    messages: Record<string, unknown>[]
  ): AgentMessageSnapshot[] {
    const snapshots: AgentMessageSnapshot[] = [];
    let fallbackCounter = 0;

    for (const message of messages) {
      fallbackCounter += 1;
      const role = typeof message.role === "string" ? message.role : "";
      if (role !== "agent") {
        continue;
      }

      const contentCandidate =
        typeof message.content === "string"
          ? message.content
          : typeof message.message === "string"
            ? message.message
            : "";
      const content = contentCandidate.trim();
      if (!content) {
        continue;
      }

      const idCandidate =
        typeof message.id === "number" && Number.isFinite(message.id)
          ? message.id
          : Number.isFinite(Number(message.id))
            ? Number(message.id)
            : fallbackCounter;

      snapshots.push({ id: idCandidate, content });
    }

    snapshots.sort((left, right) => left.id - right.id);
    return snapshots;
  }

  private combineNewAgentReplySnapshots(
    snapshots: AgentMessageSnapshot[],
    previous: AgentMessageSnapshot | null
  ): string | null {
    if (snapshots.length === 0) {
      return null;
    }

    if (!previous) {
      return snapshots[snapshots.length - 1]?.content ?? null;
    }

    const newSegments: string[] = [];
    for (const snapshot of snapshots) {
      if (snapshot.id > previous.id) {
        newSegments.push(snapshot.content);
        continue;
      }

      if (snapshot.id === previous.id && snapshot.content !== previous.content) {
        newSegments.push(snapshot.content);
      }
    }

    if (newSegments.length === 0) {
      return null;
    }

    return newSegments.join("\n\n");
  }

  private formatRunContent(threadId: string, content: string): string {
    return `[thread=${threadId}]\n${content}`;
  }

  private buildResult(
    message: HubMessage,
    status: HubResult["status"],
    source: AgentType,
    content: string,
    threadIdOverride?: string
  ): HubResult {
    return HubResultSchema.parse({
      trace_id: message.trace_id,
      thread_id: threadIdOverride ?? message.thread_id,
      source,
      status,
      content,
      attachments: [],
      timestamp: this.now().toISOString()
    });
  }

  private persistStateSafely(): void {
    try {
      savePersistedHubState(this.statePath, this.instanceManager.snapshotState());
    } catch (error) {
      this.log.warn(
        {
          trace_id: null,
          thread_id: null,
          state_path: this.statePath,
          err: error instanceof Error ? error.message : String(error)
        },
        "Failed to persist hub state"
      );
    }
  }
}
