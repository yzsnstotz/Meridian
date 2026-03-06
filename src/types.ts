import { z } from "zod";

export const ChannelSchema = z.enum(["telegram"]);
export type Channel = z.infer<typeof ChannelSchema>;

export const IntentSchema = z.enum([
  "run",
  "spawn",
  "kill",
  "status",
  "attach",
  "list",
  "switch_model",
  "monitor_update",
  "monitor_manual_update"
]);
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

export const ReplyChannelSchema = z.object({
  channel: ChannelSchema,
  chat_id: z.string().min(1),
  message_id: z.string().min(1).optional(),
  bot_id: z.string().regex(/^\d+$/).optional()
});
export type ReplyChannel = z.infer<typeof ReplyChannelSchema>;

export const HubPayloadSchema = z.object({
  content: z.string(),
  attachments: z.array(FileAttachmentSchema).default([]),
  raw_message_id: z.string().min(1).optional(),
  reply_to: z.string().nullable().optional(),
  spawn_dir: z.string().min(1).optional(),
  monitor_updates_enabled: z.boolean().optional(),
  monitor_updates_interval_sec: z.number().int().positive().optional()
});
export type HubPayload = z.infer<typeof HubPayloadSchema>;

export const HubMessageSchema = z.object({
  trace_id: z.string().uuid(),
  thread_id: z.string().min(1),
  actor_id: z.string().min(1),
  intent: IntentSchema,
  target: z.string().min(1),
  payload: HubPayloadSchema,
  mode: BridgeModeSchema,
  reply_channel: ReplyChannelSchema,
  suppress_reply: z.boolean().optional()
});
export type HubMessage = z.infer<typeof HubMessageSchema>;

export const HubResultSchema = z.object({
  trace_id: z.string().uuid(),
  thread_id: z.string().min(1),
  source: AgentTypeSchema,
  status: HubResultStatusSchema,
  content: z.string(),
  attachments: z.array(FileAttachmentSchema).default([]),
  timestamp: z.string().datetime()
});
export type HubResult = z.infer<typeof HubResultSchema>;

export const AgentInstanceSchema = z.object({
  thread_id: z.string().min(1),
  agent_type: AgentTypeSchema,
  mode: BridgeModeSchema,
  socket_path: z.string().min(1),
  working_dir: z.string().min(1).optional(),
  pid: z.number().int().nonnegative(),
  tmux_pane: z.string().nullable(),
  status: AgentInstanceStatusSchema,
  created_at: z.string().datetime()
});
export type AgentInstance = z.infer<typeof AgentInstanceSchema>;
