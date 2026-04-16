import {
  DispatcherConfigSchema,
  type AgentDispatcherConfig,
  type AgentDispatcherEditorConfig,
  type DispatcherConfig,
  type DispatchTask,
  type DispatcherEditorConfig,
  type DispatcherEditorConfigPatch,
  type DispatcherEditorTask
} from "../types";
import { parseNormalizedAgentDispatcherConfig } from "./agent-dispatcher/config-normalization";
import {
  resolveConfiguredDispatchRepoRoot,
  resolveConfiguredDocsRoot
} from "./agent-dispatcher/dispatch-paths";

export function parseMutableDispatcherConfig(config: unknown): DispatcherConfig | null {
  const parsed = DispatcherConfigSchema.safeParse(config);
  return parsed.success ? (config as DispatcherConfig) : null;
}

export function parseMutableAgentDispatcherConfig(config: unknown): AgentDispatcherConfig | null {
  return parseNormalizedAgentDispatcherConfig(config);
}

export function toEditableDispatcherConfig(config: DispatcherConfig): DispatcherEditorConfig {
  return {
    tasks: config.tasks.map((task) => ({
      task_id: task.task_id,
      instruction: task.instruction,
      instruction_template: task.instruction_template,
      depends_on: [...task.depends_on],
      target_thread_id: task.target_thread_id,
      target_model_id: task.target_model_id,
      target_agent_type: task.target_agent_type
    })),
    taskspec: config.taskspec
  };
}

export function toEditableAgentDispatcherConfig(config: AgentDispatcherConfig): AgentDispatcherEditorConfig {
  return {
    dispatch_plan_path: config.dispatch_plan_path,
    command_file_path: config.command_file_path,
    dispatch_repo_root: resolveConfiguredDispatchRepoRoot(config),
    docs_root: resolveConfiguredDocsRoot(config),
    user_reply_channels: config.user_reply_channels.map((replyChannel) => ({ ...replyChannel })),
    agent_type: config.agent_type,
    ...(config.model_id ? { model_id: config.model_id } : {}),
    mode: config.mode,
    kill_policy: config.kill_policy,
    auto_approve: config.auto_approve
  };
}

export function mergeEditableDispatcherConfig(
  current: DispatcherConfig,
  patch: DispatcherEditorConfigPatch
): DispatcherEditorConfig {
  const editable = toEditableDispatcherConfig(current);

  return {
    tasks: patch.tasks ? patch.tasks.map(cloneEditorTask) : editable.tasks,
    taskspec: Object.prototype.hasOwnProperty.call(patch, "taskspec") ? patch.taskspec : editable.taskspec
  };
}

export function applyEditableDispatcherConfig(target: DispatcherConfig, editable: DispatcherEditorConfig): void {
  target.tasks.splice(0, target.tasks.length, ...editable.tasks.map(toPersistedDispatchTask));
  target.taskspec = editable.taskspec;
}

export function cloneDispatcherConfig(config: DispatcherConfig): DispatcherConfig {
  return {
    ...config,
    tasks: config.tasks.map((task) => ({
      ...task,
      depends_on: [...task.depends_on]
    })),
    user_reply_channel: config.user_reply_channel ? { ...config.user_reply_channel } : undefined
  };
}

export function hasRunningDispatcherTask(config: DispatcherConfig): boolean {
  return config.tasks.some((task) => task.status === "running");
}

function cloneEditorTask(task: DispatcherEditorTask): DispatcherEditorTask {
  return {
    ...task,
    depends_on: [...task.depends_on]
  };
}

function toPersistedDispatchTask(task: DispatcherEditorTask): DispatchTask {
  return {
    ...cloneEditorTask(task),
    status: "pending",
    result_trace_id: undefined,
    result_summary: undefined
  };
}
