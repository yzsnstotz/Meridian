import { z } from "zod";

export const ChannelSchema = z.enum(["telegram", "web"]);
export type Channel = z.infer<typeof ChannelSchema>;

export const BUILT_IN_INTENTS = [
  "run",
  "terminal_input",
  "spawn",
  "restart",
  "reboot",
  "kill",
  "status",
  "attach",
  "detach",
  "gui",
  "list",
  "list_models",
  "switch_model",
  "detail",
  "monitor_update",
  "monitor_manual_update",
  "push",
  "capture_interval"
 ] as const;

export const BuiltInIntentSchema = z.enum(BUILT_IN_INTENTS);
export const IntentSchema = z.union([BuiltInIntentSchema, z.string().min(1)]);
export type Intent = z.infer<typeof IntentSchema>;

export const BridgeModeSchema = z.enum(["bridge", "pane_bridge"]);
export type BridgeMode = z.infer<typeof BridgeModeSchema>;

export const AgentTypeSchema = z.enum(["claude", "codex", "gemini", "cursor"]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const HubResultStatusSchema = z.enum(["success", "error", "partial", "timeout"]);
export type HubResultStatus = z.infer<typeof HubResultStatusSchema>;

export const AgentInstanceStatusSchema = z.enum(["idle", "running", "waiting", "stopped", "error"]);
export type AgentInstanceStatus = z.infer<typeof AgentInstanceStatusSchema>;

export const FileAttachmentSchema = z.object({
  path: z.string().min(1),
  filename: z.string().min(1).optional(),
  mime_type: z.string().min(1).optional()
});
export type FileAttachment = z.infer<typeof FileAttachmentSchema>;

export const TelegramInlineButtonSchema = z
  .object({
    text: z.string().min(1),
    url: z.string().url().optional(),
    callback_data: z.string().min(1).optional()
  })
  .refine((button) => (button.url ? !button.callback_data : Boolean(button.callback_data)), {
    message: "telegram inline buttons must define exactly one of url or callback_data"
  });
export type TelegramInlineButton = z.infer<typeof TelegramInlineButtonSchema>;

export const TelegramInlineKeyboardSchema = z.object({
  inline_keyboard: z.array(z.array(TelegramInlineButtonSchema).min(1)).min(1)
});
export type TelegramInlineKeyboard = z.infer<typeof TelegramInlineKeyboardSchema>;

export const InboundUIEventSchema = z.object({
  channel: ChannelSchema,
  raw_message_id: z.string().min(1),
  sender_id: z.number().int().positive(),
  content: z.string(),
  attachments: z.array(FileAttachmentSchema).default([]),
  timestamp: z.string().datetime(),
  reply_to: z.string().nullable()
});
export type InboundUIEvent = z.infer<typeof InboundUIEventSchema>;

export const CompositeChatIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*:.+$/, "chat_id must use {channel}:{id} format");
export const LegacyChatIdSchema = z.string().min(1).regex(/^[^:]+$/, "legacy chat_id cannot contain ':'");
export const SessionChatIdSchema = z.union([CompositeChatIdSchema, LegacyChatIdSchema]);
export type SessionChatId = z.infer<typeof SessionChatIdSchema>;

export const ReplyChannelSchema = z.object({
  channel: ChannelSchema,
  chat_id: SessionChatIdSchema,
  message_id: z.string().min(1).optional(),
  bot_id: z.string().regex(/^\d+$/).optional(),
  chat_name: z.string().min(1).optional(),
  bot_name: z.string().min(1).optional()
});
export type ReplyChannel = z.infer<typeof ReplyChannelSchema>;

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

export const PrioritySchema = z.number().int().min(0).max(9);
export type Priority = z.infer<typeof PrioritySchema>;

export const OptionalUuidSchema = z.string().uuid().optional();

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
  attachments: z.array(FileAttachmentSchema).default([]),
  telegram_inline_keyboard: TelegramInlineKeyboardSchema.optional(),
  timestamp: z.string().datetime()
});
export type HubResult = z.infer<typeof HubResultSchema>;

export const MonitorEventTypeSchema = z.enum([
  "task_completed",
  "status_changed",
  "heartbeat_missed",
  "agent_error",
  "sse_reconnect_failed"
]);
export type MonitorEventType = z.infer<typeof MonitorEventTypeSchema>;

export const MonitorModeSchema = z.enum(["sse_hook", "heartbeat"]);
export type MonitorMode = z.infer<typeof MonitorModeSchema>;

export const MonitorEventSchema = z.object({
  trace_id: z.string().uuid().nullable().default(null),
  span_id: OptionalUuidSchema,
  parent_span_id: OptionalUuidSchema,
  thread_id: z.string().min(1),
  event_type: MonitorEventTypeSchema,
  monitor_mode: MonitorModeSchema,
  timestamp: z.string().datetime(),
  agent_status: z.string().optional(),
  agent_type: z.string().optional(),
  last_known_pid: z.number().int().nonnegative().optional(),
  missed_heartbeats: z.number().int().nonnegative().optional(),
  sse_reconnect_count: z.number().int().nonnegative().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional()
});
export type MonitorEvent = z.infer<typeof MonitorEventSchema>;

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
  restart_safe: z.boolean().optional()
});
export type AgentInstance = z.infer<typeof AgentInstanceSchema>;

export const PaneSubscribeRequestSchema = z.object({
  type: z.literal("subscribe_pane_output"),
  thread_id: z.string().min(1),
  replay_lines: z.number().int().nonnegative().optional()
});
export type PaneSubscribeRequest = z.infer<typeof PaneSubscribeRequestSchema>;

export const PaneOutputChunkSchema = z.object({
  type: z.literal("pane_output"),
  thread_id: z.string().min(1),
  chunk: z.string(),
  cursor: z.number().int().nonnegative().optional(),
  timestamp: z.string().datetime().optional(),
  span_id: OptionalUuidSchema,
  parent_span_id: OptionalUuidSchema
});
export type PaneOutputChunk = z.infer<typeof PaneOutputChunkSchema>;

export const PaneOutputNotAvailableSchema = z.object({
  type: z.literal("not_available"),
  thread_id: z.string().min(1),
  reason: z.string().min(1)
});
export type PaneOutputNotAvailable = z.infer<typeof PaneOutputNotAvailableSchema>;

export const PaneUnsubscribeRequestSchema = z.object({
  type: z.literal("unsubscribe_pane_output"),
  thread_id: z.string().min(1)
});
export type PaneUnsubscribeRequest = z.infer<typeof PaneUnsubscribeRequestSchema>;

export const ProviderModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1)
});
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

export const ProviderModelCatalogSchema = z.object({
  thread_id: z.string().min(1),
  provider: AgentTypeSchema,
  current_model_id: z.string().min(1).nullable().default(null),
  models: z.array(ProviderModelSchema)
});
export type ProviderModelCatalog = z.infer<typeof ProviderModelCatalogSchema>;

export const ServiceEndpointSchema = z.object({
  service: z.string().min(1).optional(),
  socket_path: z.string().min(1),
  intents: z.array(z.string().min(1)).default([]),
  metadata: z.record(z.string(), z.unknown()).optional()
});
export type ServiceEndpoint = z.infer<typeof ServiceEndpointSchema>;
