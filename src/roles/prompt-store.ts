import { StateStore } from "../state-store";
import { buildSystemPromptFromConfig } from "./agent-dispatcher/prompt-builder";
import {
  AgentDispatcherConfigSchema,
  AppStateSchema,
  DispatcherConfigSchema,
  type AgentDispatcherConfig,
  type AppState,
  type DispatchTask,
  type DispatcherConfig,
  type PromptStore as PromptStoreState,
  type RoleState
} from "../types";

type PersistableStateStore = Pick<StateStore, "load" | "save">;

export interface PromptStoreRoleBinding {
  readonly roleType?: string;
  readonly config: unknown;
}

export interface PromptStoreOptions {
  stateStore?: PersistableStateStore;
  resolveRole?: (threadId: string) => PromptStoreRoleBinding | null | undefined;
}

export interface PromptTaskView {
  task_id: string;
  instruction: string;
  instruction_template?: string;
}

export interface PromptSnapshot {
  system_prompt?: string;
  tasks: PromptTaskView[];
}

export class PromptStoreNotFoundError extends Error {
  readonly statusCode = 404;

  constructor(message: string) {
    super(message);
    this.name = "PromptStoreNotFoundError";
  }
}

export class PromptStore {
  private readonly stateStore: PersistableStateStore;
  private readonly resolveRole?: PromptStoreOptions["resolveRole"];

  constructor(options: PromptStoreOptions = {}) {
    this.stateStore = options.stateStore ?? new StateStore();
    this.resolveRole = options.resolveRole;
  }

  getEffectiveInstruction(task: Pick<DispatchTask, "instruction" | "instruction_template">): string {
    return task.instruction_template ?? task.instruction;
  }

  async getPrompts(threadId: string): Promise<PromptSnapshot> {
    const context = await this.loadThreadContext(threadId);
    const promptEntry = context.state.promptStore[threadId];
    const promptOverride = normalizeSystemPrompt(promptEntry?.system_prompt, context.roleType);
    const persistedPrompt = normalizeSystemPrompt(context.config.system_prompt, context.roleType);

    return {
      system_prompt: promptOverride ?? persistedPrompt ?? context.defaultSystemPrompt,
      tasks: context.config.tasks.map((task) => ({
        task_id: task.task_id,
        instruction: task.instruction,
        instruction_template: promptEntry?.task_templates[task.task_id] ?? task.instruction_template
      }))
    };
  }

  async setSystemPrompt(threadId: string, systemPrompt: string): Promise<void> {
    const context = await this.loadThreadContext(threadId);
    const promptEntry = ensurePromptEntry(context.state.promptStore, threadId);
    const nextSystemPrompt = normalizeSystemPrompt(systemPrompt, context.roleType);

    if (nextSystemPrompt === undefined) {
      delete promptEntry.system_prompt;
    } else {
      promptEntry.system_prompt = nextSystemPrompt;
    }
    applyToKnownConfigs(context, (config) => {
      config.system_prompt = nextSystemPrompt;
    });

    await this.persistContext(context);
  }

  async setTaskTemplate(threadId: string, taskId: string, instructionTemplate: string): Promise<void> {
    const context = await this.loadThreadContext(threadId);
    const task = requireTask(context.config, taskId, threadId);
    const promptEntry = ensurePromptEntry(context.state.promptStore, threadId);

    promptEntry.task_templates[taskId] = instructionTemplate;
    task.instruction_template = instructionTemplate;

    applyToKnownConfigs(context, (config) => {
      requireTask(config, taskId, threadId).instruction_template = instructionTemplate;
    });

    await this.persistContext(context);
  }

  async deleteTaskTemplate(threadId: string, taskId: string): Promise<void> {
    const context = await this.loadThreadContext(threadId);
    const task = requireTask(context.config, taskId, threadId);
    const promptEntry = ensurePromptEntry(context.state.promptStore, threadId);

    delete promptEntry.task_templates[taskId];
    task.instruction_template = undefined;

    applyToKnownConfigs(context, (config) => {
      requireTask(config, taskId, threadId).instruction_template = undefined;
    });

    await this.persistContext(context);
  }

  private async loadThreadContext(threadId: string): Promise<PromptThreadContext> {
    const state = AppStateSchema.parse((await this.stateStore.load()) ?? { roles: [], promptStore: {} });
    const liveConfig = this.resolveLiveConfig(threadId);
    const persistedRole = findPersistedRole(state, threadId);
    const persistedConfig = persistedRole ? parseMutableRoleConfig(persistedRole.config, persistedRole.roleType) : null;
    const resolvedConfig = liveConfig ?? persistedConfig;
    const roleType = liveConfig?.roleType ?? persistedConfig?.roleType ?? "dispatcher";

    if (!resolvedConfig) {
      throw new PromptStoreNotFoundError(`Role not found for thread_id=${threadId}`);
    }

    return {
      state,
      config: resolvedConfig.config,
      liveConfig,
      persistedConfig,
      roleType,
      defaultSystemPrompt: roleType === "agent-dispatcher" && isAgentDispatcherConfig(resolvedConfig.config)
        ? buildSystemPromptFromConfig(resolvedConfig.config)
        : undefined
    };
  }

  private resolveLiveConfig(threadId: string): PromptRoleConfig | null {
    const binding = this.resolveRole?.(threadId);
    if (!binding) {
      return null;
    }

    const roleType = binding.roleType === "agent-dispatcher" ? "agent-dispatcher" : "dispatcher";
    return parseMutableRoleConfig(binding.config, roleType);
  }

  private async persistContext(context: PromptThreadContext): Promise<void> {
    const nextState: AppState = {
      roles: context.state.roles,
      promptStore: context.state.promptStore
    };

    await this.stateStore.save(AppStateSchema.parse(nextState));
  }
}

interface PromptThreadContext {
  state: AppState;
  config: PromptMutableConfig;
  liveConfig: PromptRoleConfig | null;
  persistedConfig: PromptRoleConfig | null;
  roleType: "dispatcher" | "agent-dispatcher";
  defaultSystemPrompt?: string;
}

function ensurePromptEntry(promptStore: PromptStoreState, threadId: string) {
  const existing = promptStore[threadId];
  if (existing) {
    return existing;
  }

  const created: PromptStoreState[string] = { task_templates: {} };
  promptStore[threadId] = created;
  return created;
}

function applyToKnownConfigs(
  context: PromptThreadContext,
  apply: (config: PromptMutableConfig) => void
): void {
  const visited = new Set<PromptMutableConfig>();

  for (const entry of [context.config, context.liveConfig?.config ?? null, context.persistedConfig?.config ?? null]) {
    if (!entry || visited.has(entry)) {
      continue;
    }

    visited.add(entry);
    apply(entry);
  }
}

function findPersistedRole(state: AppState, threadId: string): RoleState | null {
  return state.roles.find((role) => {
    return role.threadId === threadId && (role.roleType === "dispatcher" || role.roleType === "agent-dispatcher");
  }) ?? null;
}

type PromptMutableConfig = DispatcherConfig | AgentDispatcherConfig;

interface PromptRoleConfig {
  roleType: "dispatcher" | "agent-dispatcher";
  config: PromptMutableConfig;
}

function parseMutableRoleConfig(
  config: unknown,
  roleType: "dispatcher" | "agent-dispatcher"
): PromptRoleConfig | null {
  if (roleType === "agent-dispatcher") {
    const parsedAgentDispatcher = AgentDispatcherConfigSchema.safeParse(config);
    if (parsedAgentDispatcher.success) {
      return {
        roleType,
        config: config as AgentDispatcherConfig
      };
    }

    return null;
  }

  const parsedDispatcher = DispatcherConfigSchema.safeParse(config);
  if (parsedDispatcher.success) {
    return {
      roleType: "dispatcher",
      config: config as DispatcherConfig
    };
  }

  return null;
}

function isAgentDispatcherConfig(config: PromptMutableConfig): config is AgentDispatcherConfig {
  return AgentDispatcherConfigSchema.safeParse(config).success;
}

function normalizeSystemPrompt(
  systemPrompt: string | undefined,
  roleType: "dispatcher" | "agent-dispatcher"
): string | undefined {
  if (roleType !== "agent-dispatcher") {
    return systemPrompt;
  }

  if (typeof systemPrompt !== "string" || systemPrompt.trim().length === 0) {
    return undefined;
  }

  return systemPrompt;
}

function requireTask(config: PromptMutableConfig, taskId: string, threadId: string): DispatchTask {
  const task = config.tasks.find((candidate) => candidate.task_id === taskId);
  if (!task) {
    throw new PromptStoreNotFoundError(`Task ${taskId} not found for thread_id=${threadId}`);
  }
  return task;
}
