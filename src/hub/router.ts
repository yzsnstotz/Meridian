import { randomUUID } from "node:crypto";

import { config } from "../config";
import { createLogger } from "../logger";
import { classifyAgentOutput, type AgentOutputKind } from "../shared/agent-output";
import { resolveTelegramDetailRecord } from "./result-sender";
import { AgentAPIClient } from "../shared/agentapi-client";
import { sendIpcRequest } from "../shared/ipc";
import { buildWebGuiUrl, tryBuildGuiInlineKeyboard } from "../shared/telegram-controls";
import {
  BUILT_IN_INTENTS,
  AgentInstanceStatusSchema,
  AgentTypeSchema,
  HubMessageSchema,
  HubResultSchema,
  type AgentInstance,
  type AgentType,
  type FileAttachment,
  type HubMessage,
  type HubResult,
  type ServiceEndpoint
} from "../types";
import { InstanceManager } from "./instance-manager";
import { InstanceRegistry } from "./registry";
import { ServiceRegistry } from "./service-registry";
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
  kind: AgentOutputKind;
}

interface SessionAttachmentMetadata {
  channel: string;
  chatId: string;
  botId: string | null;
  chatName: string | null;
  botName: string | null;
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

interface PushSubscription {
  chatId: string;
  botId?: string;
}

export interface PushDeliveryTarget {
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
  serviceRegistry?: ServiceRegistry;
}

const BUILT_IN_INTENT_SET = new Set<string>(BUILT_IN_INTENTS);

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
  private readonly serviceRegistry: ServiceRegistry;
  private readonly monitorUpdateSubscriptionsByThread = new Map<string, Map<string, MonitorUpdateSubscription>>();
  private readonly pushSubscriptionsByThread = new Map<string, Map<string, PushSubscription>>();
  private readonly attachmentMetaBySession = new Map<string, SessionAttachmentMetadata>();

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
    this.serviceRegistry = options.serviceRegistry ?? new ServiceRegistry();
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
    this.pruneAttachmentMetadata();
    const startedAt = Date.now();
    this.log.info(
      {
        trace_id: message.trace_id,
        thread_id: message.thread_id,
        actor_id: message.actor_id,
        span_id: message.span_id ?? null,
        parent_span_id: message.parent_span_id ?? null,
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
          span_id: message.span_id ?? null,
          parent_span_id: message.parent_span_id ?? null,
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
          span_id: message.span_id ?? null,
          parent_span_id: message.parent_span_id ?? null,
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
    if (this.isBuiltInIntent(message.intent)) {
      switch (message.intent) {
        case "run":
          return await this.handleRun(message);
        case "terminal_input":
          return this.handleTerminalInput(message);
        case "status":
          return await this.handleStatus(message);
        case "list":
          return this.handleList(message);
        case "list_models":
          return await this.handleListModels(message);
        case "spawn":
          return await this.handleSpawn(message);
        case "restart":
          return await this.handleRestart(message);
        case "kill":
          return await this.handleKill(message);
        case "attach":
          return this.handleAttach(message);
        case "detach":
          return this.handleDetach(message);
        case "reboot":
          return await this.handleReboot(message);
        case "gui":
          return this.handleGui(message);
        case "switch_model":
          return await this.handleSwitchModel(message);
        case "detail":
          return this.handleDetail(message);
        case "monitor_update":
          return this.handleMonitorUpdate(message);
        case "monitor_manual_update":
          return await this.handleManualMonitorUpdate(message);
        case "push":
          return this.handlePush(message);
        default:
          return this.buildResult(message, "error", this.resolveResultSource(message), "Unsupported intent");
      }
    }

    const serviceEndpoint = this.serviceRegistry.resolve(message.intent);
    if (serviceEndpoint) {
      return await this.dispatchToService(serviceEndpoint, message);
    }

    return this.buildResult(message, "error", this.resolveResultSource(message), "Unsupported intent");
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
      const runLogContext = { trace_id: message.trace_id, thread_id: instance.thread_id };
      const agentReply = await this.waitForAgentReply(client, previousSnapshot, runLogContext);
      if (agentReply === null) {
        this.log.warn(
          runLogContext,
          "Run using fallback content: waitForAgentReply returned null; response body or getLatestAgentMessageSnapshot used as result content"
        );
      }
      const content = this.formatRunContent(
        instance.thread_id,
        agentReply ?? (await this.resolveFallbackRunContent(client, response))
      );
      const attachments = this.extractResultAttachments(response);
      return this.buildResult(
        message,
        "success",
        instance.agent_type,
        content,
        instance.thread_id,
        { attachments }
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
    const content = this.appendAttachmentSummary(JSON.stringify(status, null, 2), status.instance.thread_id);
    return this.buildResult(
      message,
      "success",
      status.instance.agent_type,
      content,
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
      const attachedLabels = attachment.sessions.map((session) => this.describeAttachedSession(session));
      return {
        ...instance,
        attached: attachment.sessions.length > 0,
        attached_sessions: attachment.sessions,
        attached_labels: attachedLabels,
        attached_interface: attachment.interface_id,
        attachable
      };
    });
    const content = listedInstances.length === 0 ? "No active agent instances." : JSON.stringify(listedInstances, null, 2);
    return this.buildResult(message, "success", this.resolveResultSource(message), content);
  }

  private async handleListModels(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const catalog = await this.instanceManager.listModels(threadId);
    return this.buildResult(message, "success", instance.agent_type, JSON.stringify(catalog, null, 2), threadId);
  }

  private async handleSpawn(message: HubMessage): Promise<HubResult> {
    const type = AgentTypeSchema.parse(message.target);
    const spawnDir = message.payload.spawn_dir?.trim() || undefined;
    const threadId = await this.instanceManager.spawn(type, message.mode, spawnDir);
    const sessionId = encodeSessionId(message.reply_channel.chat_id, message.reply_channel.bot_id);
    this.instanceManager.attach(threadId, sessionId);
    this.rememberAttachmentMetadata(sessionId, message);
    const spawned = this.registry.get(threadId);
    const baseContent =
      spawned === undefined
        ? `Spawned ${type} instance: ${threadId}`
        : JSON.stringify({ thread_id: threadId, instance: spawned }, null, 2);
    return this.buildResult(message, "success", type, this.appendAttachmentSummary(baseContent, threadId), threadId, {
      telegramInlineKeyboard: tryBuildGuiInlineKeyboard(threadId, message.payload.gui_host_port_override)
    });
  }

  private async handleKill(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const attachment = this.instanceManager.getThreadAttachment(threadId);
    const attachmentSummary = this.buildAttachmentSummary(attachment.sessions);
    await this.instanceManager.kill(threadId);
    for (const session of attachment.sessions) {
      this.forgetAttachmentMetadata(session);
    }
    const content = attachmentSummary
      ? `Agent instance ${threadId} killed\n\n${attachmentSummary}`
      : `Agent instance ${threadId} killed`;
    return this.buildResult(
      message,
      "success",
      instance.agent_type,
      content,
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
    return this.buildResult(
      message,
      "success",
      instance.agent_type,
      this.appendAttachmentSummary(content, restartedThreadId),
      restartedThreadId
    );
  }

  private handleAttach(message: HubMessage): HubResult {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const sessionId = encodeSessionId(message.reply_channel.chat_id, message.reply_channel.bot_id);
    const binding = this.instanceManager.attach(threadId, sessionId);
    this.rememberAttachmentMetadata(sessionId, message);
    const content = this.appendAttachmentSummary(JSON.stringify(binding, null, 2), threadId);
    return this.buildResult(message, "success", instance.agent_type, content, threadId, {
      telegramInlineKeyboard: tryBuildGuiInlineKeyboard(threadId, message.payload.gui_host_port_override)
    });
  }

  private handleDetach(message: HubMessage): HubResult {
    const sessionId = encodeSessionId(message.reply_channel.chat_id, message.reply_channel.bot_id);
    const expectedThreadId = this.extractConcreteThreadId(message.target) ?? this.extractConcreteThreadId(message.thread_id);
    const attachedThreadId = this.instanceManager.getAttachedThread(sessionId);

    if (!attachedThreadId) {
      throw new Error(`No thread is attached for session=${message.reply_channel.chat_id}`);
    }
    if (expectedThreadId && attachedThreadId !== expectedThreadId) {
      throw new Error(`Session is attached to ${attachedThreadId}, not ${expectedThreadId}`);
    }

    const detachedThreadId = this.instanceManager.detach(sessionId);
    if (!detachedThreadId) {
      throw new Error(`No thread is attached for session=${message.reply_channel.chat_id}`);
    }
    this.forgetAttachmentMetadata(sessionId);

    const source = this.registry.get(detachedThreadId)?.agent_type ?? this.resolveResultSource(message);
    return this.buildResult(
      message,
      "success",
      source,
      `Detached session from ${detachedThreadId}`,
      detachedThreadId
    );
  }

  private async handleReboot(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const rebootedThreadId = await this.instanceManager.restart(threadId);
    const rebooted = this.registry.get(rebootedThreadId);
    const content =
      rebooted === undefined
        ? `Rebooted ${threadId}`
        : JSON.stringify({ thread_id: rebootedThreadId, instance: rebooted }, null, 2);
    return this.buildResult(
      message,
      "success",
      instance.agent_type,
      this.appendAttachmentSummary(content, rebootedThreadId),
      rebootedThreadId
    );
  }

  private handleGui(message: HubMessage): HubResult {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const content = this.appendAttachmentSummary(
      buildWebGuiUrl(threadId, message.payload.gui_host_port_override),
      threadId
    );
    return this.buildResult(message, "success", instance.agent_type, content, threadId);
  }

  private async handleSwitchModel(message: HubMessage): Promise<HubResult> {
    const threadId = this.resolveThreadIdFromThread(message);
    const instance = this.resolveInstance(threadId);
    const modelId = message.payload.content.trim();
    if (!modelId) {
      throw new Error("switch_model requires a provider model id");
    }
    const switchedThreadId = await this.instanceManager.switchModel(threadId, modelId);
    const switched = this.registry.get(switchedThreadId);
    const content =
      switched === undefined
        ? `Switched ${threadId} to model=${modelId}`
        : JSON.stringify({ thread_id: switchedThreadId, instance: switched }, null, 2);
    return this.buildResult(
      message,
      "success",
      instance.agent_type,
      this.appendAttachmentSummary(content, switchedThreadId),
      switchedThreadId
    );
  }

  private handleDetail(message: HubMessage): HubResult {
    if (message.reply_channel.channel !== "telegram") {
      return this.buildResult(
        message,
        "error",
        this.resolveResultSource(message),
        "detail is only available for Telegram reply channels."
      );
    }

    const requestedTrace = message.payload.content.trim() || undefined;
    const requestedThread = this.extractConcreteThreadId(message.target) ?? this.extractConcreteThreadId(message.thread_id) ?? undefined;
    const detail = resolveTelegramDetailRecord({
      chatId: message.reply_channel.chat_id,
      botId: message.reply_channel.bot_id,
      traceId: requestedTrace,
      threadId: requestedThread
    });

    if (!detail) {
      return this.buildResult(
        message,
        "success",
        this.resolveResultSource(message),
        "No cached detail found. Send a new request first, then run /detail again."
      );
    }

    const title = `Detail for trace=${detail.traceId} thread=${detail.threadId}`;
    return this.buildResult(
      message,
      "success",
      detail.source,
      `${title}\n\n${detail.fullText}`,
      detail.threadId
    );
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

  private pruneAttachmentMetadata(): void {
    const activeSessions = new Set<string>();
    for (const instance of this.registry.list()) {
      const attachment = this.instanceManager.getThreadAttachment(instance.thread_id);
      for (const session of attachment.sessions) {
        activeSessions.add(session);
      }
    }

    for (const session of this.attachmentMetaBySession.keys()) {
      if (!activeSessions.has(session)) {
        this.attachmentMetaBySession.delete(session);
      }
    }
  }

  private rememberAttachmentMetadata(sessionId: string, message: HubMessage): void {
    this.attachmentMetaBySession.set(sessionId, {
      channel: message.reply_channel.channel,
      chatId: message.reply_channel.chat_id,
      botId: message.reply_channel.bot_id ?? null,
      chatName: message.reply_channel.chat_name?.trim() || null,
      botName: message.reply_channel.bot_name?.trim() || null
    });
  }

  private forgetAttachmentMetadata(sessionId: string): void {
    this.attachmentMetaBySession.delete(sessionId);
  }

  private appendAttachmentSummary(content: string, threadId: string): string {
    const attachment = this.instanceManager.getThreadAttachment(threadId);
    const summary = this.buildAttachmentSummary(attachment.sessions);
    if (!summary) {
      return content;
    }
    return `${content}\n\n${summary}`;
  }

  private buildAttachmentSummary(sessions: string[]): string | null {
    if (sessions.length === 0) {
      return null;
    }
    const lines = ["Attached chat sessions:"];
    for (const session of sessions) {
      lines.push(`- ${this.describeAttachedSession(session)}`);
    }
    return lines.join("\n");
  }

  private describeAttachedSession(session: string): string {
    const metadata = this.attachmentMetaBySession.get(session);
    const parsed = this.parseSession(session);
    const chatLabel = metadata?.chatName ?? parsed.chatId;
    const botLabel = this.resolveBotLabel(metadata?.botName, metadata?.botId ?? parsed.botId);
    if (botLabel) {
      return `${chatLabel} via ${botLabel}`;
    }
    return chatLabel;
  }

  private parseSession(session: string): { botId: string | null; chatId: string } {
    const separatorIndex = session.indexOf(":");
    if (separatorIndex <= 0) {
      return { botId: null, chatId: session };
    }

    const maybeBotId = session.slice(0, separatorIndex);
    const rest = session.slice(separatorIndex + 1);
    if (/^\d+$/.test(maybeBotId)) {
      return { botId: maybeBotId, chatId: rest };
    }
    return { botId: null, chatId: session };
  }

  private resolveBotLabel(botName: string | null | undefined, botId: string | null): string | null {
    const normalizedBotName = botName?.trim() ?? "";
    if (normalizedBotName) {
      return normalizedBotName.startsWith("@") ? normalizedBotName : `@${normalizedBotName}`;
    }
    if (botId) {
      return `bot#${botId}`;
    }
    return null;
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

  resolveInstanceForThread(threadId: string): AgentInstance | null {
    return this.registry.get(threadId) ?? null;
  }

  registerServiceEndpoint(endpoint: ServiceEndpoint): ServiceEndpoint {
    return this.serviceRegistry.register(endpoint);
  }

  unregisterServiceEndpoint(serviceId: string): boolean {
    return this.serviceRegistry.unregister(serviceId);
  }

  listServiceEndpoints(): ServiceEndpoint[] {
    return this.serviceRegistry.list();
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
        telegram_inline_keyboard: tryBuildGuiInlineKeyboard(threadId),
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

  private isBuiltInIntent(intent: string): boolean {
    return BUILT_IN_INTENT_SET.has(intent);
  }

  private async dispatchToService(endpoint: ServiceEndpoint, message: HubMessage): Promise<HubResult> {
    const childMessage = {
      ...message,
      parent_span_id: message.span_id,
      span_id: randomUUID()
    };
    const response = await sendIpcRequest<HubMessage, HubResult>(endpoint.socket_path, childMessage);
    return HubResultSchema.parse(response);
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

  private extractResultAttachments(response: Record<string, unknown>): FileAttachment[] {
    const rawFiles = response.files;
    if (!Array.isArray(rawFiles)) {
      return [];
    }

    const attachments: FileAttachment[] = [];
    for (const rawFile of rawFiles) {
      if (typeof rawFile === "string") {
        const normalizedPath = rawFile.trim();
        if (!normalizedPath) {
          continue;
        }
        attachments.push({
          path: normalizedPath
        });
        continue;
      }

      if (!rawFile || typeof rawFile !== "object") {
        continue;
      }

      const candidate = rawFile as Record<string, unknown>;
      const normalizedPath =
        typeof candidate.path === "string"
          ? candidate.path.trim()
          : typeof candidate.file_path === "string"
            ? candidate.file_path.trim()
            : typeof candidate.abspath === "string"
              ? candidate.abspath.trim()
              : "";
      if (!normalizedPath) {
        continue;
      }

      attachments.push({
        path: normalizedPath,
        filename:
          typeof candidate.filename === "string"
            ? candidate.filename.trim() || undefined
            : typeof candidate.name === "string"
              ? candidate.name.trim() || undefined
              : typeof candidate.basename === "string"
                ? candidate.basename.trim() || undefined
                : undefined,
        mime_type:
          typeof candidate.mime_type === "string"
            ? candidate.mime_type.trim() || undefined
            : typeof candidate.mimeType === "string"
              ? candidate.mimeType.trim() || undefined
              : undefined
      });
    }

    return attachments;
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
      return snapshot;
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

  // ── Push subscription management ──

  private handlePush(message: HubMessage): HubResult {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const enabled = message.payload.push_enabled;

    if (instance.mode !== "pane_bridge") {
      return this.buildResult(
        message, "error", instance.agent_type,
        "Push is only available for pane_bridge mode instances.",
        threadId
      );
    }

    const isWebChannel = message.reply_channel.channel === "web";

    if (isWebChannel) {
      return this.handlePushFromWeb(message, threadId, instance, enabled);
    }

    const chatId = message.reply_channel.chat_id;
    const botId = message.reply_channel.bot_id;
    const sessionId = encodeSessionId(chatId, botId);

    if (enabled === undefined || enabled === null) {
      const existing = this.pushSubscriptionsByThread.get(threadId)?.get(sessionId);
      const state = existing ? "ON" : "OFF";
      return this.buildResult(
        message, "success", instance.agent_type,
        `Push agent text is ${state} for thread=${threadId}.`,
        threadId
      );
    }

    if (!enabled) {
      this.deletePushSubscription(threadId, sessionId);
      return this.buildResult(
        message, "success", instance.agent_type,
        `Push agent text turned OFF for thread=${threadId}.`,
        threadId
      );
    }

    this.upsertPushSubscription(threadId, sessionId, chatId, botId);
    return this.buildResult(
      message, "success", instance.agent_type,
      `Push agent text turned ON for thread=${threadId}.`,
      threadId
    );
  }

  private handlePushFromWeb(
    message: HubMessage,
    threadId: string,
    instance: AgentInstance,
    enabled: boolean | undefined | null
  ): HubResult {
    const existingCount = this.pushSubscriptionsByThread.get(threadId)?.size ?? 0;

    if (enabled === undefined || enabled === null) {
      const state = existingCount > 0 ? "ON" : "OFF";
      return this.buildResult(
        message, "success", instance.agent_type,
        `Push agent text is ${state} for thread=${threadId} (${existingCount} subscriber(s)).`,
        threadId
      );
    }

    if (!enabled) {
      this.pushSubscriptionsByThread.delete(threadId);
      return this.buildResult(
        message, "success", instance.agent_type,
        `Push agent text turned OFF for thread=${threadId}.`,
        threadId
      );
    }

    const attachedSessions = this.getAttachedSessionsForThread(threadId);
    let subscribed = 0;
    for (const session of attachedSessions) {
      const parsed = this.parseSessionTarget(session);
      if (!parsed) continue;
      this.upsertPushSubscription(threadId, session, parsed.chatId, parsed.botId);
      subscribed++;
    }

    if (subscribed === 0) {
      return this.buildResult(
        message, "error", instance.agent_type,
        `No attached Telegram sessions for thread=${threadId}. Use Telegram /push on to subscribe.`,
        threadId
      );
    }

    return this.buildResult(
      message, "success", instance.agent_type,
      `Push agent text turned ON for thread=${threadId} (${subscribed} session(s)).`,
      threadId
    );
  }

  private parseSessionTarget(session: string): { chatId: string; botId?: string } | null {
    if (!session || session.startsWith("web:")) return null;
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

  private upsertPushSubscription(threadId: string, sessionId: string, chatId: string, botId: string | undefined): void {
    let byChat = this.pushSubscriptionsByThread.get(threadId);
    if (!byChat) {
      byChat = new Map();
      this.pushSubscriptionsByThread.set(threadId, byChat);
    }
    byChat.set(sessionId, { chatId, botId });
  }

  private deletePushSubscription(threadId: string, sessionId: string): void {
    const byChat = this.pushSubscriptionsByThread.get(threadId);
    if (!byChat) return;
    byChat.delete(sessionId);
    if (byChat.size === 0) {
      this.pushSubscriptionsByThread.delete(threadId);
    }
  }

  getPushDeliveryTargets(): PushDeliveryTarget[] {
    const targets: PushDeliveryTarget[] = [];
    for (const [threadId, byChat] of this.pushSubscriptionsByThread.entries()) {
      for (const sub of byChat.values()) {
        targets.push({ threadId, chatId: sub.chatId, botId: sub.botId });
      }
    }
    return targets;
  }

  getThreadsWithPushSubscriptions(): string[] {
    return [...this.pushSubscriptionsByThread.keys()];
  }

  getPushSubscriptionsForThread(threadId: string): PushSubscription[] {
    const byChat = this.pushSubscriptionsByThread.get(threadId);
    if (!byChat) return [];
    return [...byChat.values()];
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
    previousSnapshot: AgentMessageSnapshot | null,
    runLogContext?: { trace_id: string; thread_id: string }
  ): Promise<string | null> {
    if (!client.getMessages) {
      this.log.warn(
        { ...runLogContext, reason: "client_has_no_getMessages" },
        "waitForAgentReply returning null: client does not implement getMessages"
      );
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
      } catch (error) {
        this.log.warn(
          {
            ...runLogContext,
            reason: "getMessages_threw",
            err: error instanceof Error ? error.message : String(error)
          },
          "waitForAgentReply returning null: getMessages() threw"
        );
        return null;
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }

    if (candidate && candidateTail && !this.isTransientTerminalFrame(candidateTail)) {
      return candidate;
    }

    if (candidate === null) {
      this.log.warn(
        {
          ...runLogContext,
          reason: "no_stable_reply_within_max_attempts",
          max_attempts: maxAttempts,
          delay_ms: delayMs
        },
        "waitForAgentReply returning null: no stable agent reply within max attempts (GET /messages empty, all transient, or isNewAgentReply never true)"
      );
    }
    return candidate;
  }

  private async resolveFallbackRunContent(
    client: AgentClient,
    response: Record<string, unknown>
  ): Promise<string> {
    const isAck = this.isTransportAckResponse(response);
    const extracted = this.extractContent(response);

    if (!isAck && extracted.trim().length > 0) {
      return extracted;
    }

    const latestSnapshot = await this.getLatestAgentMessageSnapshot(client);
    if (latestSnapshot?.content && !this.isTransientTerminalFrame(latestSnapshot.content)) {
      return latestSnapshot.content;
    }

    if (isAck) {
      return "Message sent. Agent is processing — reply will arrive via monitor update.";
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
    return classifyAgentOutput(content).kind === "transient";
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
      const classified = classifyAgentOutput(contentCandidate);
      const content = classified.text.trim();
      if (!content || classified.kind === "transient") {
        continue;
      }

      const idCandidate =
        typeof message.id === "number" && Number.isFinite(message.id)
          ? message.id
          : Number.isFinite(Number(message.id))
            ? Number(message.id)
            : fallbackCounter;

      snapshots.push({ id: idCandidate, content, kind: classified.kind });
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

  private formatRunContent(_threadId: string, content: string): string {
    return content;
  }

  private buildResult(
    message: HubMessage,
    status: HubResult["status"],
    source: AgentType,
    content: string,
    threadIdOverride?: string,
    options?: {
      attachments?: FileAttachment[];
      telegramInlineKeyboard?: HubResult["telegram_inline_keyboard"];
    }
  ): HubResult {
    return HubResultSchema.parse({
      trace_id: message.trace_id,
      thread_id: threadIdOverride ?? message.thread_id,
      source,
      status,
      content,
      attachments: options?.attachments ?? [],
      telegram_inline_keyboard: options?.telegramInlineKeyboard,
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
