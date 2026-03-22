import {
  DispatcherConfigSchema,
  type DispatcherConfig,
  type DispatchTask,
  type DispatcherEditorConfig,
  type DispatcherEditorConfigPatch,
  type DispatcherEditorTask
} from "../types";

export function parseMutableDispatcherConfig(config: unknown): DispatcherConfig | null {
  const parsed = DispatcherConfigSchema.safeParse(config);
  return parsed.success ? (config as DispatcherConfig) : null;
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
