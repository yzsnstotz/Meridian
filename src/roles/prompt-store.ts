import { StateStore } from "../state-store";
import {
  AppStateSchema,
  DispatcherConfigSchema,
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

    return {
      system_prompt: promptEntry?.system_prompt ?? context.config.system_prompt,
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

    promptEntry.system_prompt = systemPrompt;
    applyToKnownConfigs(context, (config) => {
      config.system_prompt = systemPrompt;
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
    const persistedConfig = persistedRole ? parseMutableDispatcherConfig(persistedRole.config) : null;
    const config = liveConfig ?? persistedConfig;

    if (!config) {
      throw new PromptStoreNotFoundError(`Role not found for thread_id=${threadId}`);
    }

    return {
      state,
      config,
      liveConfig,
      persistedConfig
    };
  }

  private resolveLiveConfig(threadId: string): DispatcherConfig | null {
    const binding = this.resolveRole?.(threadId);
    if (!binding || (binding.roleType && binding.roleType !== "dispatcher")) {
      return null;
    }

    return parseMutableDispatcherConfig(binding.config);
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
  config: DispatcherConfig;
  liveConfig: DispatcherConfig | null;
  persistedConfig: DispatcherConfig | null;
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
  apply: (config: DispatcherConfig) => void
): void {
  const visited = new Set<DispatcherConfig>();

  for (const config of [context.config, context.liveConfig, context.persistedConfig]) {
    if (!config || visited.has(config)) {
      continue;
    }

    visited.add(config);
    apply(config);
  }
}

function findPersistedRole(state: AppState, threadId: string): RoleState | null {
  return state.roles.find((role) => role.threadId === threadId && role.roleType === "dispatcher") ?? null;
}

function parseMutableDispatcherConfig(config: unknown): DispatcherConfig | null {
  const parsed = DispatcherConfigSchema.safeParse(config);
  return parsed.success ? (config as DispatcherConfig) : null;
}

function requireTask(config: DispatcherConfig, taskId: string, threadId: string): DispatchTask {
  const task = config.tasks.find((candidate) => candidate.task_id === taskId);
  if (!task) {
    throw new PromptStoreNotFoundError(`Task ${taskId} not found for thread_id=${threadId}`);
  }
  return task;
}
