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
      const response = await client.sendMessage(message.payload.content, message.payload.attachments);
      this.registry.setStatus(instance.thread_id, "running");
      return this.buildResult(
        message,
        "success",
        instance.agent_type,
        this.extractContent(response),
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
