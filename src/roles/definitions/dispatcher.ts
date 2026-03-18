import { randomUUID } from "node:crypto";

import { ROLES_SERVICE_ID, ROLES_SOCKET_PATH } from "../../config";
import { StateStore } from "../../state-store";
import {
  DispatcherConfigSchema,
  type AgentInstance,
  type AppState,
  type DispatchTask,
  type DispatcherConfig,
  type HubMessage,
  type HubResult,
  type ReplyChannel
} from "../../types";
import type { BaseRole, RoleContext } from "../base-role";

type PersistableStateStore = Pick<StateStore, "load" | "save">;

export interface DispatcherRoleOptions {
  stateStore?: PersistableStateStore;
  traceIdFactory?: () => string;
}

export class DispatcherRole implements BaseRole {
  readonly roleType = "dispatcher" as const;
  readonly threadId: string;
  readonly config: DispatcherConfig;

  private readonly tasks: DispatchTask[];
  private readonly stateStore: PersistableStateStore;
  private readonly traceIdFactory: () => string;
  private readonly tasksById = new Map<string, DispatchTask>();
  private readonly downstreamByTaskId = new Map<string, string[]>();
  private readonly executionOrder: string[] = [];

  private ctx: RoleContext | null = null;
  private completionTriggered = false;
  private transitionChain: Promise<void> = Promise.resolve();

  constructor(threadId: string, config: unknown, options: DispatcherRoleOptions = {}) {
    const parsedConfig = DispatcherConfigSchema.parse(config);
    const normalizedConfig = normalizeDispatcherConfig(parsedConfig);

    this.threadId = threadId;
    this.config = normalizedConfig;
    this.tasks = normalizedConfig.tasks;
    this.stateStore = options.stateStore ?? new StateStore();
    this.traceIdFactory = options.traceIdFactory ?? randomUUID;
  }

  async onActivate(ctx: RoleContext): Promise<void> {
    this.ctx = ctx;

    try {
      this.initializeGraph();
      await this.persistState();
      await this.dispatchReadyTasks();
      await this.maybeSendCompletionSummary();
    } catch (error) {
      this.ctx = null;
      throw error;
    }
  }

  async onDeactivate(): Promise<void> {
    this.ctx = null;
    await this.removePersistedRole();
  }

  async onInboundResult(result: HubResult): Promise<void> {
    return this.enqueueTransition(async () => {
      const task = this.tasks.find((candidate) => candidate.result_trace_id === result.trace_id);
      if (!task) {
        return;
      }

      task.status = result.status === "success" || result.status === "partial" ? "done" : "failed";
      task.result_summary = truncate(result.content, 500);

      if (task.status === "failed") {
        this.markDownstreamFailed(task.task_id, `Blocked by failed dependency: ${task.task_id}`);
      }

      await this.persistState();
      await this.dispatchReadyTasks();
      await this.maybeSendCompletionSummary();
    });
  }

  async onStatusChange(_threadId: string, _status: string): Promise<void> {
    return undefined;
  }

  private initializeGraph(): void {
    this.tasksById.clear();
    this.downstreamByTaskId.clear();

    for (const task of this.tasks) {
      if (this.tasksById.has(task.task_id)) {
        throw new Error(`Duplicate task_id: ${task.task_id}`);
      }
      this.tasksById.set(task.task_id, task);
      this.downstreamByTaskId.set(task.task_id, []);
    }

    for (const task of this.tasks) {
      for (const dependencyId of task.depends_on) {
        const dependency = this.tasksById.get(dependencyId);
        if (!dependency) {
          throw new Error(`Task ${task.task_id} depends on unknown task ${dependencyId}`);
        }
        this.downstreamByTaskId.get(dependency.task_id)?.push(task.task_id);
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (taskId: string): void => {
      if (visiting.has(taskId)) {
        throw new Error(`Circular dependency detected at task ${taskId}`);
      }
      if (visited.has(taskId)) {
        return;
      }

      visiting.add(taskId);
      const task = this.tasksById.get(taskId);
      if (!task) {
        throw new Error(`Missing task ${taskId}`);
      }

      for (const dependencyId of task.depends_on) {
        visit(dependencyId);
      }

      visiting.delete(taskId);
      visited.add(taskId);
    };

    for (const task of this.tasks) {
      visit(task.task_id);
    }
  }

  private async dispatchReadyTasks(): Promise<void> {
    const readyTasks = this.tasks.filter((task) => task.status === "pending" && this.areDependenciesDone(task));
    if (readyTasks.length === 0) {
      return;
    }

    for (const task of readyTasks) {
      await this.dispatchTask(task);
    }
  }

  private async dispatchTask(task: DispatchTask): Promise<void> {
    const ctx = this.requireContext();
    const traceId = this.traceIdFactory();

    task.result_trace_id = traceId;
    task.status = "running";

    try {
      const target = this.resolveTarget(task, ctx.listInstances());
      const message: HubMessage = {
        trace_id: traceId,
        thread_id: this.threadId,
        actor_id: ROLES_SERVICE_ID,
        intent: "run",
        target,
        priority: 5,
        payload: {
          content: task.instruction_template ?? task.instruction,
          attachments: []
        },
        mode: "bridge",
        reply_channel: {
          channel: "socket",
          chat_id: ROLES_SERVICE_ID,
          socket_path: ROLES_SOCKET_PATH
        },
        suppress_reply: false
      };

      await ctx.sendToHub(message);
      this.executionOrder.push(task.task_id);
    } catch (error) {
      task.status = "failed";
      task.result_summary = truncate(`Dispatch failed: ${asError(error).message}`, 500);
      this.markDownstreamFailed(task.task_id, `Blocked by failed dependency: ${task.task_id}`);
      ctx.log.error("Dispatcher task dispatch failed", {
        dispatcherThreadId: this.threadId,
        taskId: task.task_id,
        error: asError(error).message
      });
    }

    await this.persistState();
  }

  private resolveTarget(task: DispatchTask, instances: AgentInstance[]): string {
    if (task.target_thread_id) {
      return task.target_thread_id;
    }

    if (task.target_model_id) {
      const match = instances.find((instance) => instance.status === "idle" && instance.model_id === task.target_model_id);
      if (match) {
        return match.thread_id;
      }
      throw new Error(`No idle instance found for model_id=${task.target_model_id}`);
    }

    if (task.target_agent_type) {
      const match = instances.find((instance) => instance.status === "idle" && instance.agent_type === task.target_agent_type);
      if (match) {
        return match.thread_id;
      }
      throw new Error(`No idle instance found for agent_type=${task.target_agent_type}`);
    }

    const idleInstance = instances.find((instance) => instance.status === "idle");
    if (idleInstance) {
      return idleInstance.thread_id;
    }

    throw new Error("No idle instance available for dispatcher task");
  }

  private areDependenciesDone(task: DispatchTask): boolean {
    return task.depends_on.every((dependencyId) => this.tasksById.get(dependencyId)?.status === "done");
  }

  private markDownstreamFailed(taskId: string, reason: string): void {
    const queue = [...(this.downstreamByTaskId.get(taskId) ?? [])];
    const seen = new Set<string>();

    while (queue.length > 0) {
      const currentTaskId = queue.shift();
      if (!currentTaskId || seen.has(currentTaskId)) {
        continue;
      }

      seen.add(currentTaskId);
      const task = this.tasksById.get(currentTaskId);
      if (!task) {
        continue;
      }

      if (task.status === "pending") {
        task.status = "failed";
        task.result_summary = task.result_summary ?? reason;
      }

      queue.push(...(this.downstreamByTaskId.get(currentTaskId) ?? []));
    }
  }

  private async maybeSendCompletionSummary(): Promise<void> {
    if (this.completionTriggered || !this.tasks.every((task) => isTerminalStatus(task.status))) {
      return;
    }

    this.completionTriggered = true;
    await this.persistState();

    const ctx = this.requireContext();
    if (!this.config.user_reply_channel) {
      ctx.log.warn("Dispatcher completed without a user reply channel", {
        dispatcherThreadId: this.threadId
      });
      return;
    }

    try {
      await ctx.sendToHub(this.buildCompletionMessage(this.config.user_reply_channel));
    } catch (error) {
      ctx.log.error("Dispatcher completion summary send failed", {
        dispatcherThreadId: this.threadId,
        error: asError(error).message
      });
    }
  }

  private buildCompletionMessage(replyChannel: ReplyChannel): HubMessage {
    return {
      trace_id: this.traceIdFactory(),
      thread_id: this.threadId,
      actor_id: ROLES_SERVICE_ID,
      intent: "run",
      target: "global",
      priority: 5,
      payload: {
        content: this.buildCompletionSummaryMarkdown(),
        attachments: []
      },
      mode: "bridge",
      reply_channel: replyChannel,
      suppress_reply: true
    };
  }

  private buildCompletionSummaryMarkdown(): string {
    const lines = [
      `# Dispatcher Summary: ${this.threadId}`,
      "",
      "## Execution Order"
    ];

    if (this.executionOrder.length === 0) {
      lines.push("No tasks were dispatched.");
    } else {
      this.executionOrder.forEach((taskId, index) => {
        lines.push(`${index + 1}. ${taskId}`);
      });
    }

    lines.push("", "## Task Results");
    for (const task of this.tasks) {
      const summary = truncate(task.result_summary ?? "", 200);
      lines.push(`- ${task.task_id}: ${task.status}${summary ? ` | ${summary}` : ""}`);
    }

    return lines.join("\n");
  }

  private async persistState(): Promise<void> {
    const currentState = await this.stateStore.load();
    const roles = (currentState?.roles ?? []).filter((role) => role.threadId !== this.threadId);

    roles.push({
      threadId: this.threadId,
      roleType: this.roleType,
      config: this.snapshotConfig(),
      status: this.tasks.every((task) => isTerminalStatus(task.status)) ? "completed" : "active"
    });

    const nextState: AppState = {
      roles,
      promptStore: currentState?.promptStore ?? {}
    };

    await this.stateStore.save(nextState);
  }

  private async removePersistedRole(): Promise<void> {
    const currentState = await this.stateStore.load();
    if (!currentState) {
      return;
    }

    const nextRoles = currentState.roles.filter((role) => role.threadId !== this.threadId);
    if (nextRoles.length === currentState.roles.length) {
      return;
    }

    await this.stateStore.save({
      roles: nextRoles,
      promptStore: currentState.promptStore
    });
  }

  private snapshotConfig(): DispatcherConfig {
    return {
      ...this.config,
      tasks: this.tasks.map((task) => ({
        ...task,
        depends_on: [...task.depends_on]
      })),
      user_reply_channel: this.config.user_reply_channel ? { ...this.config.user_reply_channel } : undefined
    };
  }

  private enqueueTransition(work: () => Promise<void>): Promise<void> {
    const next = this.transitionChain.then(work, work);
    this.transitionChain = next.then(() => undefined, () => undefined);
    return next;
  }

  private requireContext(): RoleContext {
    if (!this.ctx) {
      throw new Error("Dispatcher role is not active");
    }
    return this.ctx;
  }
}

function normalizeDispatcherConfig(config: DispatcherConfig): DispatcherConfig {
  return {
    ...config,
    tasks: config.tasks.map((task) => ({
      ...task,
      depends_on: [...task.depends_on]
    })),
    user_reply_channel: config.user_reply_channel ? { ...config.user_reply_channel } : undefined
  };
}

function isTerminalStatus(status: DispatchTask["status"]): boolean {
  return status === "done" || status === "failed";
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
