import { createLogger } from "../logger";
import { AgentAPIClient } from "../shared/agentapi-client";
import {
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

export interface HubRouterOptions {
  clientFactory?: (threadId: string) => AgentClient;
  instanceManager?: InstanceManager;
  now?: () => Date;
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
  }

  async route(rawMessage: HubMessage): Promise<HubResult> {
    const message = HubMessageSchema.parse(rawMessage);
    this.log.info(
      {
        trace_id: message.trace_id,
        thread_id: message.thread_id,
        intent: message.intent,
        target: message.target
      },
      "Routing HubMessage"
    );

    try {
      const result = await this.routeByIntent(message);
      this.log.info(
        {
          trace_id: message.trace_id,
          thread_id: message.thread_id,
          intent: message.intent,
          status: result.status,
          target: message.target
        },
        "Hub routing complete"
      );
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error(
        {
          trace_id: message.trace_id,
          thread_id: message.thread_id,
          intent: message.intent,
          target: message.target,
          err: errorMessage
        },
        "Hub routing failed"
      );
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
      case "status":
        return await this.handleStatus(message);
      case "list":
        return this.handleList(message);
      case "spawn":
        return await this.handleSpawn(message);
      case "kill":
        return await this.handleKill(message);
      case "attach":
        return this.handleAttach(message);
      case "switch_model":
        return await this.handleSwitchModel(message);
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
    const instances = this.instanceManager.list();
    const content = instances.length === 0 ? "No active agent instances." : JSON.stringify(instances, null, 2);
    return this.buildResult(message, "success", this.resolveResultSource(message), content);
  }

  private async handleSpawn(message: HubMessage): Promise<HubResult> {
    const type = AgentTypeSchema.parse(message.target);
    const threadId = await this.instanceManager.spawn(type, message.mode);
    this.instanceManager.attach(threadId, message.reply_channel.chat_id);
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

  private handleAttach(message: HubMessage): HubResult {
    const threadId = this.resolveThreadId(message);
    const instance = this.resolveInstance(threadId);
    const binding = this.instanceManager.attach(threadId, message.reply_channel.chat_id);
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

    const attachedThread = this.instanceManager.getAttachedThread(message.reply_channel.chat_id);
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

    const attachedThread = this.instanceManager.getAttachedThread(message.reply_channel.chat_id);
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

  private async getLatestAgentMessageSnapshot(client: AgentClient): Promise<AgentMessageSnapshot | null> {
    if (!client.getMessages) {
      return null;
    }

    try {
      const messages = await client.getMessages();
      return this.extractLatestAgentMessage(messages);
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
    let candidate: AgentMessageSnapshot | null = null;
    let stablePolls = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const messages = await client.getMessages();
        const latest = this.extractLatestAgentMessage(messages);

        if (latest && this.isNewAgentReply(latest, previousSnapshot)) {
          const changedCandidate =
            !candidate || latest.id !== candidate.id || latest.content !== candidate.content;
          if (changedCandidate) {
            candidate = latest;
            stablePolls = 0;
          } else {
            stablePolls += 1;
          }

          if (candidate && !this.isTransientTerminalFrame(candidate.content) && stablePolls >= 2) {
            return candidate.content;
          }
        }
      } catch {
        return null;
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }

    if (candidate && !this.isTransientTerminalFrame(candidate.content)) {
      return candidate.content;
    }

    return candidate?.content ?? null;
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

  private extractLatestAgentMessage(
    messages: Record<string, unknown>[]
  ): AgentMessageSnapshot | null {
    let winner: AgentMessageSnapshot | null = null;
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

      if (!winner || idCandidate > winner.id) {
        winner = { id: idCandidate, content };
      }
    }

    return winner;
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
}
