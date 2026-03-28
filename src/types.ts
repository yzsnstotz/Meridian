import { z } from "zod";

// ─── Enums & Primitives ────────────────────────────────────────────────────────
// Copied from Meridian types.ts for alignment

export const ChannelSchema = z.enum(["telegram", "web", "socket"]);
export type Channel = z.infer<typeof ChannelSchema>;

export const AgentTypeSchema = z.enum(["claude", "codex", "gemini", "cursor"]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const HubResultStatusSchema = z.enum(["success", "error", "partial", "timeout"]);
export type HubResultStatus = z.infer<typeof HubResultStatusSchema>;

export const AgentInstanceStatusSchema = z.enum(["idle", "running", "waiting", "stopped", "error"]);
export type AgentInstanceStatus = z.infer<typeof AgentInstanceStatusSchema>;

export const BridgeModeSchema = z.enum(["bridge", "pane_bridge"]);
export type BridgeMode = z.infer<typeof BridgeModeSchema>;

export const IntentSchema = z.union([
  z.enum([
    "run", "terminal_input", "spawn", "restart", "reboot", "kill",
    "status", "attach", "detach", "gui", "list", "list_models",
    "switch_model", "detail", "monitor_update", "monitor_manual_update",
    "push", "capture_interval", "history", "set_auto_approve"
  ]),
  z.string().min(1)
]);
export type Intent = z.infer<typeof IntentSchema>;

// ─── Shared Sub-schemas ────────────────────────────────────────────────────────

export const FileAttachmentSchema = z.object({
  path: z.string().min(1),
  filename: z.string().min(1).optional(),
  mime_type: z.string().min(1).optional()
});
export type FileAttachment = z.infer<typeof FileAttachmentSchema>;

export const CompositeChatIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*:.+$/, "chat_id must use {channel}:{id} format");
export const LegacyChatIdSchema = z.string().min(1).regex(/^[^:]+$/, "legacy chat_id cannot contain ':'");
export const SessionChatIdSchema = z.union([CompositeChatIdSchema, LegacyChatIdSchema]);
export type SessionChatId = z.infer<typeof SessionChatIdSchema>;

// ─── ReplyChannel (CRITICAL — must match Meridian types.ts L84-93 exactly) ───

export const ReplyChannelSchema = z.object({
  channel: ChannelSchema,
  chat_id: SessionChatIdSchema,
  message_id: z.string().min(1).optional(),
  bot_id: z.string().regex(/^\d+$/).optional(),
  chat_name: z.string().min(1).optional(),
  bot_name: z.string().min(1).optional(),
  // required when channel === 'socket'
  socket_path: z.string().min(1).optional()
});
export type ReplyChannel = z.infer<typeof ReplyChannelSchema>;

// ─── Hub Message / Result (aligned with Meridian) ──────────────────────────────

export const PrioritySchema = z.number().int().min(0).max(9);
export type Priority = z.infer<typeof PrioritySchema>;

export const OptionalUuidSchema = z.string().uuid().optional();

export const HubPayloadSchema = z.object({
  content: z.string(),
  attachments: z.array(FileAttachmentSchema).default([]),
  raw_message_id: z.string().min(1).optional(),
  reply_to: z.string().nullable().optional(),
  spawn_dir: z.string().min(1).optional(),
  monitor_updates_enabled: z.boolean().optional(),
  monitor_updates_interval_sec: z.number().int().positive().optional(),
  gui_host_port_override: z.string().min(1).optional(),
  push_enabled: z.boolean().optional()
});
export type HubPayload = z.infer<typeof HubPayloadSchema>;

export const HubMessageSchema = z.object({
  trace_id: z.string().uuid(),
  thread_id: z.string().min(1),
  actor_id: z.string().min(1),
  idempotency_key: z.string().min(1).optional(),
  priority: PrioritySchema.default(5),
  span_id: OptionalUuidSchema,
  parent_span_id: OptionalUuidSchema,
  intent: IntentSchema,
  target: z.string().min(1),
  payload: HubPayloadSchema,
  mode: BridgeModeSchema,
  reply_channel: ReplyChannelSchema,
  suppress_reply: z.boolean().optional()
});
export type HubMessage = z.input<typeof HubMessageSchema>;

export const HubResultSchema = z.object({
  trace_id: z.string().uuid(),
  thread_id: z.string().min(1),
  source: AgentTypeSchema,
  status: HubResultStatusSchema,
  content: z.string(),
  summary_text: z.string().optional(),
  details_text: z.string().optional(),
  attachments: z.array(FileAttachmentSchema).default([]),
  timestamp: z.string().datetime()
});
export type HubResult = z.infer<typeof HubResultSchema>;

// ─── Agent Instance (aligned with Meridian) ─────────────────────────────────────

export const AgentInstanceSchema = z.object({
  thread_id: z.string().min(1),
  agent_type: AgentTypeSchema,
  model_id: z.string().min(1).optional(),
  mode: BridgeModeSchema,
  socket_path: z.string().min(1),
  working_dir: z.string().min(1).optional(),
  pid: z.number().int().nonnegative(),
  tmux_pane: z.string().nullable(),
  status: AgentInstanceStatusSchema,
  created_at: z.string().datetime(),
  restart_safe: z.boolean().optional(),
  auto_approve: z.boolean().default(false)
});
export type AgentInstance = z.input<typeof AgentInstanceSchema>;

// ─── meridian-roles specific types ──────────────────────────────────────────────

export const RoleTypeSchema = z.enum(["dispatcher", "agent-dispatcher"]);
export type RoleType = z.infer<typeof RoleTypeSchema>;

export const TaskStatusSchema = z.enum(["pending", "running", "done", "failed"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const DispatchTaskSchema = z.object({
  task_id: z.string().min(1),
  instruction: z.string().min(1),
  instruction_template: z.string().min(1).optional(),
  depends_on: z.array(z.string()).default([]),
  target_thread_id: z.string().min(1).optional(),
  target_model_id: z.string().min(1).optional(),
  target_agent_type: AgentTypeSchema.optional(),
  status: TaskStatusSchema.default("pending"),
  result_trace_id: z.string().uuid().optional(),
  result_summary: z.string().optional()
});
export type DispatchTask = z.infer<typeof DispatchTaskSchema>;

export const DispatcherEditorTaskSchema = z.object({
  task_id: z.string().min(1),
  instruction: z.string().min(1),
  instruction_template: z.string().min(1).optional(),
  depends_on: z.array(z.string()).default([]),
  target_thread_id: z.string().min(1).optional(),
  target_model_id: z.string().min(1).optional(),
  target_agent_type: AgentTypeSchema.optional()
}).strict();
export type DispatcherEditorTask = z.infer<typeof DispatcherEditorTaskSchema>;

export const DispatcherEditorConfigSchema = z.object({
  tasks: z.array(DispatcherEditorTaskSchema).default([]),
  taskspec: z.string().optional()
}).strict();
export type DispatcherEditorConfig = z.infer<typeof DispatcherEditorConfigSchema>;

export const DispatcherEditorConfigPatchSchema = DispatcherEditorConfigSchema.partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one editable dispatcher config field is required" }
);
export type DispatcherEditorConfigPatch = z.infer<typeof DispatcherEditorConfigPatchSchema>;

export const DispatcherConfigSchema = z.object({
  tasks: z.array(DispatchTaskSchema).default([]),
  taskspec: z.string().optional(),
  user_reply_channel: ReplyChannelSchema.optional(),
  system_prompt: z.string().optional()
});
export type DispatcherConfig = z.infer<typeof DispatcherConfigSchema>;

export const KillPolicySchema = z.enum(["always", "on_success", "never"]);
export type KillPolicy = z.infer<typeof KillPolicySchema>;

export const AgentDispatcherConfigSchema = DispatcherConfigSchema.extend({
  dispatch_plan_path: z.string().min(1),
  command_file_path: z.string().min(1),
  user_reply_channels: z.array(ReplyChannelSchema).min(1).optional(),
  agent_type: AgentTypeSchema.default("claude"),
  mode: BridgeModeSchema.default("bridge"),
  kill_policy: KillPolicySchema.default("always"),
  use_agent_dispatcher: z.boolean().optional()
})
  .superRefine((value, ctx) => {
    const hasReplyChannels = Array.isArray(value.user_reply_channels) && value.user_reply_channels.length > 0;
    if (!hasReplyChannels && !value.user_reply_channel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["user_reply_channels"],
        message: "user_reply_channels is required"
      });
    }
  })
  .transform((value) => {
    const userReplyChannels = value.user_reply_channels?.map(cloneReplyChannel)
      ?? (value.user_reply_channel ? [cloneReplyChannel(value.user_reply_channel)] : []);
    const primaryReplyChannel = userReplyChannels[0];

    return {
      ...value,
      user_reply_channel: primaryReplyChannel ? cloneReplyChannel(primaryReplyChannel) : undefined,
      user_reply_channels: userReplyChannels,
      use_agent_dispatcher: value.use_agent_dispatcher ?? true
    };
  });
export type AgentDispatcherConfig = z.infer<typeof AgentDispatcherConfigSchema>;

export function shouldUseAgentDispatcherConfig(config: unknown): boolean {
  return typeof config === "object"
    && config !== null
    && "use_agent_dispatcher" in config
    && (config as { use_agent_dispatcher?: unknown }).use_agent_dispatcher === true;
}

// ─── State persistence schema ───────────────────────────────────────────────────

export const RoleStateSchema = z.object({
  threadId: z.string().min(1),
  roleType: RoleTypeSchema,
  config: z.unknown().optional(),
  status: z.string().default("active")
});
export type RoleState = z.infer<typeof RoleStateSchema>;

export const PromptStoreSchema = z.record(z.string(), z.object({
  system_prompt: z.string().optional(),
  task_templates: z.record(z.string(), z.string()).default({})
})).default({});
export type PromptStore = z.infer<typeof PromptStoreSchema>;

export const AppStateSchema = z.object({
  roles: z.array(RoleStateSchema).default([]),
  promptStore: PromptStoreSchema
});
export type AppState = z.infer<typeof AppStateSchema>;

function cloneReplyChannel(replyChannel: ReplyChannel): ReplyChannel {
  return { ...replyChannel };
}
