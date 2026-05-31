import { z } from "zod";

// ─── Enums & Primitives ────────────────────────────────────────────────────────
// Copied from Meridian types.ts for alignment

export const ChannelSchema = z.enum(["telegram", "web", "socket"]);
export type Channel = z.infer<typeof ChannelSchema>;

export const AgentTypeSchema = z.enum(["claude", "codex", "gemini", "cursor"]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const HubResultStatusSchema = z.enum(["success", "error", "partial", "timeout"]);
export type HubResultStatus = z.infer<typeof HubResultStatusSchema>;

export const HubRunStateSchema = z.enum(["completed", "still_running", "timeout"]);
export type HubRunState = z.infer<typeof HubRunStateSchema>;

export const AgentInstanceStatusSchema = z.enum(["idle", "running", "waiting", "stopped", "error"]);
export type AgentInstanceStatus = z.infer<typeof AgentInstanceStatusSchema>;

// Mirrors the meridian-hub BridgeMode contract. `pane_bridge` was removed
// 2026-05-21 (meridian-hub PR #93): operators standardized on telegram + a2a
// (`bridge`) and the tmux-pane-attach surface was unused. The Stateful*
// variant exists to forbid `stateless_call` at call sites that need a
// persistent thread reservation.
export const StatefulBridgeModeSchema = z.enum(["bridge"]);
export type StatefulBridgeMode = z.infer<typeof StatefulBridgeModeSchema>;

export const BridgeModeSchema = z.enum(["bridge", "stateless_call"]);
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

export const ChatterReadOnlyQuerySchema = z.object({
  skill: z.string().min(1),
  args: z.record(z.string(), z.unknown())
});
export type ChatterReadOnlyQuery = z.infer<typeof ChatterReadOnlyQuerySchema>;

export const ChatterReadOnlyQueryResultSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().min(1).optional()
});
export type ChatterReadOnlyQueryResult = z.infer<typeof ChatterReadOnlyQueryResultSchema>;

export const ChatterObservationProposedPatchSchema = z.object({
  record_type: z.string().min(1),
  key: z.string().min(1),
  patch: z.record(z.string(), z.unknown())
});
export type ChatterObservationProposedPatch = z.infer<typeof ChatterObservationProposedPatchSchema>;

export const ChatterCandidateObservationSchema = z.object({
  observation_id: z.string().uuid(),
  type: z.string().min(1),
  description: z.string().min(1),
  proposed_patch: ChatterObservationProposedPatchSchema
});
export type ChatterCandidateObservation = z.infer<typeof ChatterCandidateObservationSchema>;

export const ChatterExtractStageSchema = z.enum([
  "uploaded",
  "asking_genre",
  "asking_main_hook",
  "asking_cliff_pattern",
  "asking_transition_types",
  "awaiting_final_confirm",
  "committed"
]);
export type ChatterExtractStage = z.infer<typeof ChatterExtractStageSchema>;

export const ChatterExtractStateSchema = z.object({
  stage: ChatterExtractStageSchema,
  question: z.string().min(1).optional(),
  options: z.array(z.string().min(1)).optional(),
  draft_template: z.record(z.string(), z.unknown()).optional()
});
export type ChatterExtractState = z.infer<typeof ChatterExtractStateSchema>;

export const ChatterTurnOriginSchema = z.enum(["user", "trigger"]).default("user").optional();
export type ChatterTurnOrigin = NonNullable<z.infer<typeof ChatterTurnOriginSchema>>;

export const ChatterCoeditTargetSchema = z.object({
  label: z.string().min(1).max(160),
  path: z.string().min(1).max(240),
  block_id: z.string().min(1).max(240).optional(),
  story_id: z.string().min(1).max(240).optional(),
  value: z.string().max(20_000).optional()
});
export type ChatterCoeditTarget = z.infer<typeof ChatterCoeditTargetSchema>;

export const MumuReplyParseStatusSchema = z.enum([
  "parsed",
  "missing_markers",
  "reversed_markers",
  "unterminated_block",
  "empty_block",
  "unsafe_content"
]);
export type MumuReplyParseStatus = z.infer<typeof MumuReplyParseStatusSchema>;

export const MumuReplyParseDiagnosticsSchema = z.object({
  ok: z.boolean(),
  status: MumuReplyParseStatusSchema,
  fallback_used: z.boolean(),
  valid_block_count: z.number().int().min(0)
});
export type MumuReplyParseDiagnostics = z.infer<typeof MumuReplyParseDiagnosticsSchema>;

export const MumuTranscriptOriginSchema = z.enum([
  "typed_chat",
  "direct_generation",
  "coedit",
  "control",
  "assistant_reply"
]);
export type MumuTranscriptOrigin = z.infer<typeof MumuTranscriptOriginSchema>;

export const MumuTranscriptEnvelopeSchema = z.object({
  user_display_content: z.string().min(1).max(20_000).optional(),
  assistant_display_content: z.string().min(1).max(20_000).optional(),
  origin: MumuTranscriptOriginSchema.optional()
});
export type MumuTranscriptEnvelope = z.infer<typeof MumuTranscriptEnvelopeSchema>;

export const MumuPromptPartKindSchema = z.enum([
  "base_system_prompt",
  "context",
  "account_preferences",
  "ads_contract",
  "user_request"
]);
export type MumuPromptPartKind = z.infer<typeof MumuPromptPartKindSchema>;

export const MumuPromptPartSchema = z.object({
  id: z.string().min(1).max(160),
  kind: MumuPromptPartKindSchema,
  content: z.string().min(1).max(120_000)
});
export type MumuPromptPart = z.infer<typeof MumuPromptPartSchema>;

export const MumuPreferenceStatusSchema = z.enum(["not_provided", "applied", "ignored", "invalid"]);
export type MumuPreferenceStatus = z.infer<typeof MumuPreferenceStatusSchema>;

export const MumuChatterDiagnosticsSchema = z.object({
  prompt_part_ids: z.array(z.string().min(1).max(160)).optional(),
  preference_status: MumuPreferenceStatusSchema.optional(),
  reply_parse: MumuReplyParseDiagnosticsSchema.optional()
});
export type MumuChatterDiagnostics = z.infer<typeof MumuChatterDiagnosticsSchema>;

export const MumuAgentSessionStatusSchema = z.enum(["unbound", "alive", "dead", "restarting"]);
export type MumuAgentSessionStatus = z.infer<typeof MumuAgentSessionStatusSchema>;

export const MumuChatterSessionStateSchema = z.object({
  transcript_session_id: z.string().min(1),
  agent_session_id: z.string().min(1).nullable(),
  agent_session_status: MumuAgentSessionStatusSchema,
  history_replay: z.boolean()
});
export type MumuChatterSessionState = z.infer<typeof MumuChatterSessionStateSchema>;

export const ChatterTurnEnvelopeSchema = z.object({
  mode: z.enum(["stateless", "session"]).optional(),
  chatter_session_id: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
  story_id: z.string().min(1).optional(),
  template_id: z.string().min(1).optional(),
  genre: z.string().min(1).optional(),
  system_prompt_id: z.string().min(1).optional(),
  origin: ChatterTurnOriginSchema,
  context_refs: z.array(z.object({ type: z.string(), key: z.string() })).optional(),
  transcript: MumuTranscriptEnvelopeSchema.optional(),
  prompt_parts: z.array(MumuPromptPartSchema).optional(),
  diagnostics: MumuChatterDiagnosticsSchema.optional(),
  read_only_query: ChatterReadOnlyQuerySchema.optional(),
  read_only_query_result: ChatterReadOnlyQueryResultSchema.optional(),
  extract_state: ChatterExtractStateSchema.optional(),
  attachment_ref: z.string().min(1).optional(),
  candidate_observation: ChatterCandidateObservationSchema.optional(),
  observation_id: z.string().uuid().optional(),
  coedit_target: ChatterCoeditTargetSchema.optional(),
  session_state: MumuChatterSessionStateSchema.optional(),
  control: z.enum(["new", "interrupt", "confirm_observation", "reject_observation"]).optional(),
  reply_parse: MumuReplyParseDiagnosticsSchema.optional()
});
export type ChatterTurnEnvelope = z.infer<typeof ChatterTurnEnvelopeSchema>;

export const HubToolDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1)
});
export type HubToolDescriptor = z.infer<typeof HubToolDescriptorSchema>;

export const HubPayloadSchema = z.object({
  content: z.string(),
  attachments: z.array(FileAttachmentSchema).default([]),
  raw_message_id: z.string().min(1).optional(),
  reply_to: z.string().nullable().optional(),
  spawn_dir: z.string().min(1).optional(),
  model_id: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  auto_approve: z.boolean().optional(),
  monitor_updates_enabled: z.boolean().optional(),
  monitor_updates_interval_sec: z.number().int().positive().optional(),
  gui_host_port_override: z.string().min(1).optional(),
  push_enabled: z.boolean().optional(),
  // Meridian-hub PR #78 reads payload.credential_id on intent:"spawn" to bind
  // the spawned codex/claude process to a managed CODEX_HOME (auth.json etc.).
  // Roles that want their agent to run under a specific credential set this
  // when constructing outbound messages. Existing roles leave it undefined
  // and inherit ambient credentials.
  credential_id: z.string().min(1).optional(),
  // Optional role-owned tool surface metadata for spawned agent sessions.
  tool_descriptors: z.array(HubToolDescriptorSchema).optional(),
  chatter: ChatterTurnEnvelopeSchema.optional()
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
  suppress_reply: z.boolean().optional(),
  streaming_delivery: z.boolean().optional()
});
export type HubMessage = z.input<typeof HubMessageSchema>;

// Optional payload extras carried on hub-to-role inbound. Distinct from
// HubMessage.payload (which has required content + attachments) — this is a
// passthrough container for role-specific envelopes (e.g. ChatterTurnEnvelope)
// that the originating sender attached to a forwarded request. Every existing
// role ignores it; only Chatter reads `payload.chatter`.
export const HubResultPayloadSchema = z.object({
  chatter: ChatterTurnEnvelopeSchema.optional()
}).optional();
export type HubResultPayload = z.infer<typeof HubResultPayloadSchema>;

export const HubResultSchema = z.object({
  trace_id: z.string().uuid(),
  thread_id: z.string().min(1),
  source: z.string().min(1),
  status: HubResultStatusSchema,
  run_state: HubRunStateSchema.optional(),
  content: z.string(),
  // Tolerate `null` here — some hub backends (and synthetic hub_results
  // injected for lifecycle recovery) write an explicit null summary/details.
  // Without `.nullable()` Zod throws and `loadDispatchLifecycleState` falls
  // back to an empty state, blanking every worker bar in the role detail GUI.
  summary_text: z.string().nullable().optional(),
  details_text: z.string().nullable().optional(),
  attachments: z.array(FileAttachmentSchema).default([]),
  timestamp: z.string().datetime(),
  payload: HubResultPayloadSchema
});
export type HubResult = z.infer<typeof HubResultSchema>;

export const PmResolverIssueStateSchema = z.object({
  status: z.string().min(1),
  worker_id: z.string().min(1).nullable().default(null),
  message: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  source: z.string().min(1).default("dispatcher")
});
export type PmResolverIssueState = z.infer<typeof PmResolverIssueStateSchema>;

export const PmResolverResultStateSchema = z.object({
  status: z.string().min(1),
  run_state: z.string().nullable().default(null),
  content: z.string().nullable().default(null),
  summary_text: z.string().nullable().default(null),
  details_text: z.string().nullable().default(null),
  trace_id: z.string().nullable().default(null),
  timestamp: z.string().datetime().nullable().default(null)
});
export type PmResolverResultState = z.infer<typeof PmResolverResultStateSchema>;

export const PmResolverLifecycleStatusSchema = z.enum(["running", "completed", "failed"]);
export type PmResolverLifecycleStatus = z.infer<typeof PmResolverLifecycleStatusSchema>;

// Canonical decision the PM resolver agent emitted in its MeridianStatusMarker
// reply. Persisted on the lifecycle entry so the dispatcher can gate respawn
// behavior on operator-relevant verdicts (notably `escalate_human`) without
// re-parsing prose content on every sweep.
export const PmResolverMarkerOutcomeSchema = z.enum(["resolved", "escalated"]);
export type PmResolverMarkerOutcome = z.infer<typeof PmResolverMarkerOutcomeSchema>;
export const PmResolverMarkerActionSchema = z.enum([
  "retry",
  "skip",
  "force_complete",
  "wait",
  "escalate_human"
]);
export type PmResolverMarkerAction = z.infer<typeof PmResolverMarkerActionSchema>;

export const PmResolverLifecycleStateSchema = z.object({
  thread_id: z.string().min(1),
  status: PmResolverLifecycleStatusSchema,
  started_at: z.string().datetime(),
  last_seen_at: z.string().datetime(),
  agent_type: z.string().min(1).nullable().default(null),
  model_id: z.string().min(1).nullable().default(null),
  mode: z.string().min(1).nullable().default(null),
  auto_approve: z.boolean().nullable().default(null),
  issue: PmResolverIssueStateSchema,
  result: PmResolverResultStateSchema.nullable().default(null),
  error: z.string().nullable().default(null),
  // Transport-class failure of the PM run (hub overload, Meridian-API
  // unreachable, request timeout, etc.) recorded WITHOUT killing the thread
  // or flipping status to "failed", so a human can still talk into the PM
  // session via the GUI talk-box. Cleared on successful PM run completion.
  transport_error: z.string().nullable().default(null),
  // Marker decision extracted from the PM resolver's MeridianStatusMarker
  // reply. Populated only when the marker validates and matches this PM's
  // target worker_id; absent for envelope-mapped or wrong-role outcomes so
  // downstream gates do not confuse cross-talk with a real PM verdict.
  marker_outcome: PmResolverMarkerOutcomeSchema.nullable().default(null),
  marker_pm_action: PmResolverMarkerActionSchema.nullable().default(null)
});
export type PmResolverLifecycleState = z.infer<typeof PmResolverLifecycleStateSchema>;

export const LifecycleStatusSchema = z.enum([
  "pending", "running", "completed", "failed", "blocked", "abandoned", "skipped",
  "awaiting_validation", "fix_requested"
]);
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>;

export const DispatchLifecycleDispatcherSchema = z.object({
  thread_id: z.string().min(1).nullable().default(null),
  started_at: z.string().datetime().nullable().default(null),
  status: LifecycleStatusSchema.default("pending")
});
export type DispatchLifecycleDispatcher = z.infer<typeof DispatchLifecycleDispatcherSchema>;

export const ValidationHistoryEntrySchema = z.object({
  cycle: z.number().int(),
  score: z.number().min(0).max(1),
  feedback: z.string(),
  validator_thread_id: z.string().min(1),
  timestamp: z.string().datetime()
});
export type ValidationHistoryEntry = z.infer<typeof ValidationHistoryEntrySchema>;

export const ValidationStateSchema = z.object({
  current_cycle: z.number().int().min(0).default(0),
  max_fix_cycles: z.number().int().default(3),
  validator_thread_id: z.string().min(1).nullable().default(null),
  last_score: z.number().min(0).max(1).nullable().default(null),
  last_feedback: z.string().nullable().default(null),
  history: z.array(ValidationHistoryEntrySchema).default([]),
  // Tracks consecutive validator-spawn-or-run failures so the watchdog and
  // queue can apply a backoff. Optional for backward compatibility with
  // older state files and existing test fixtures; readers must coalesce
  // (`?? 0`).
  spawn_failure_count: z.number().int().min(0).optional(),
  last_spawn_failure_at: z.string().datetime().nullable().optional()
});
export type ValidationState = z.infer<typeof ValidationStateSchema>;

export const HumanResolutionSchema = z.object({
  resolved_at: z.string().datetime(),
  note: z.string().nullable().default(null)
});
export type HumanResolution = z.infer<typeof HumanResolutionSchema>;

export const DispatchWorkerStateSchema = z.object({
  // Empty string is the sentinel for "cleared for relaunch" written by
  // clearWorkerThreadForRelaunch when validator-feedback delivery fails on a
  // dead worker thread (typically after a hub restart or thread expiry).
  // Consumers already gate on `worker.thread_id?.trim()`. min(1) here used to
  // throw on save and trap the worker in an infinite respawn loop.
  thread_id: z.string(),
  trace_id: z.string().nullable().default(null),
  started_at: z.string().datetime(),
  last_seen_at: z.string().datetime(),
  status: LifecycleStatusSchema,
  expected_outputs: z.array(z.string().min(1)).default([]),
  hub_result: HubResultSchema.nullable().default(null),
  applied_model_id: z.string().min(1).optional(),
  applied_reasoning_effort: z.string().min(1).optional(),
  command_preamble: z.string().nullable().default(null),
  retry_count: z.number().int().min(0).default(0),
  validation: ValidationStateSchema.optional(),
  // Set when an operator resolved a blocked worker out-of-band (e.g. by
  // talking directly to the worker thread because PM was killed after
  // escalation). Persists alongside lifecycle status so the GUI can surface
  // a HUMAN-resolved badge and downstream gates can ignore the prior PM
  // failure.
  human_resolution: HumanResolutionSchema.nullable().optional()
});
export type DispatchWorkerState = z.infer<typeof DispatchWorkerStateSchema>;

export const DispatchThreadStateV2Schema = z.object({
  version: z.literal(2),
  dispatcher: DispatchLifecycleDispatcherSchema.default({
    thread_id: null,
    started_at: null,
    status: "pending"
  }),
  workers: z.record(z.string(), DispatchWorkerStateSchema).default({}),
  pm_resolvers: z.array(PmResolverLifecycleStateSchema).optional(),
  last_reconciled_at: z.string().datetime().nullable().default(null)
});
export type DispatchThreadStateV2 = z.infer<typeof DispatchThreadStateV2Schema>;

export type LifecycleWorkerEntry = DispatchWorkerState & {
  worker_id: string;
};

// ─── Auto-Resolve Configuration ─────────────────────────────────────────────────

export interface AutoResolveConfig {
  enabled: boolean;
  taskspecDir: string;
  maxAutoResolveAttempts: number;
  humanEscalationPatterns: RegExp[];
}

export const DEFAULT_HUMAN_ESCALATION_PATTERNS: RegExp[] = [
  /\bMISSING:/i,
  /\bcredentials?\b/i,
  /\bauth(?:entication)?\b/i,
  /\btoken\b/i,
  /\bAPI\s*key\b/i,
  /\bservice\s+unavailable\b/i,
  /\brequires?\s+human\b/i,
  /\bmanual(?:ly)?\s+(?:repair|fix|resolve)\b/i,
];

// ─── Agent Instance (aligned with Meridian) ─────────────────────────────────────

export const AgentInstanceSchema = z.object({
  thread_id: z.string().min(1),
  agent_type: AgentTypeSchema,
  model_id: z.string().min(1).optional(),
  supportsStream: z.boolean().optional(),
  codexSessionId: z.string().min(1).optional(),
  mode: BridgeModeSchema,
  // A `stopped` / `error` instance has no live socket and no running pid —
  // the Hub reports these fields as `null`. The status enum already admits
  // those states, so the schema must too; requiring a non-null string/number
  // here made one dead instance reject the WHOLE `AgentInstance[]` payload.
  socket_path: z.string().min(1).nullable(),
  working_dir: z.string().min(1).optional(),
  pid: z.number().int().nonnegative().nullable(),
  status: AgentInstanceStatusSchema,
  created_at: z.string().datetime(),
  last_interaction_at: z.string().datetime().nullable().optional(),
  restart_safe: z.boolean().optional(),
  auto_approve: z.boolean().default(false)
});
export type AgentInstance = z.input<typeof AgentInstanceSchema>;

// ─── meridian-roles specific types ──────────────────────────────────────────────

export const RoleTypeSchema = z.enum(["dispatcher", "agent-dispatcher", "scheduler", "chatter"]);
export type RoleType = z.infer<typeof RoleTypeSchema>;

export const TaskStatusSchema = z.enum(["pending", "running", "done", "failed", "blocked"]);
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

export const DispatchModelOverrideSchema = z.object({
  provider: z.string().min(1),
  model_id: z.string().min(1)
});
export type DispatchModelOverride = z.infer<typeof DispatchModelOverrideSchema>;

export const DispatchModelMapSchema = z.record(z.string().min(1), DispatchModelOverrideSchema);
export type DispatchModelMap = z.infer<typeof DispatchModelMapSchema>;

export const ValidatorThresholdTypeSchema = z.enum(["score", "binary"]);
export type ValidatorThresholdType = z.infer<typeof ValidatorThresholdTypeSchema>;

export const ValidatorConfigSchema = z.object({
  enabled: z.boolean().default(false),
  agent_type: AgentTypeSchema.default("codex"),
  model_id: z.string().min(1).optional(),
  credential_id: z.string().min(1).optional(),
  mode: BridgeModeSchema.optional(),
  auto_approve: z.boolean().default(false),
  threshold_type: ValidatorThresholdTypeSchema.default("score"),
  pass_threshold: z.number().min(0).max(1).default(0.7),
  max_fix_cycles: z.number().int().min(0).max(10).default(3),
  base_branch: z.string().min(1).default("main")
})
  .superRefine((value, ctx) => {
    const resolvedMode = value.mode ?? defaultValidatorModeForAgent(value.agent_type);
    if (resolvedMode === "stateless_call" && value.agent_type !== "codex") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mode"],
        message: "stateless_call validator mode is only supported for codex"
      });
    }
  })
  .transform((value) => ({
    ...value,
    mode: value.mode ?? defaultValidatorModeForAgent(value.agent_type)
  }));
export type ValidatorConfig = z.infer<typeof ValidatorConfigSchema>;

function defaultValidatorModeForAgent(agentType: AgentType): BridgeMode {
  return agentType === "codex" ? "stateless_call" : "bridge";
}

export const PmResolverConfigSchema = z.object({
  enabled: z.boolean().default(true),
  agent_type: AgentTypeSchema.default("codex"),
  model_id: z.string().min(1).optional(),
  credential_id: z.string().min(1).optional(),
  mode: StatefulBridgeModeSchema.default("bridge"),
  auto_approve: z.boolean().default(false),
  user_reply_channels: z.array(ReplyChannelSchema).min(1).optional()
});
export type PmResolverConfig = z.infer<typeof PmResolverConfigSchema>;

export const ParallelDispatchConfigSchema = z.object({
  enabled: z.boolean().default(false),
  max_concurrency: z.number().int().min(1).default(1)
});
export type ParallelDispatchConfig = z.infer<typeof ParallelDispatchConfigSchema>;

export const AgentDispatcherConfigSchema = DispatcherConfigSchema.extend({
  dispatch_plan_path: z.string().min(1),
  command_file_path: z.string().min(1),
  dispatch_repo_root: z.string().min(1).optional(),
  docs_root: z.string().min(1).optional(),
  user_reply_channels: z.array(ReplyChannelSchema).min(1).optional(),
  agent_type: AgentTypeSchema.default("claude"),
  model_id: z.string().min(1).optional(),
  credential_id: z.string().min(1).optional(),
  mode: StatefulBridgeModeSchema.default("bridge"),
  kill_policy: KillPolicySchema.default("always"),
  auto_approve: z.boolean().default(false),
  model_map: DispatchModelMapSchema.optional(),
  use_agent_dispatcher: z.boolean().optional(),
  validator: ValidatorConfigSchema.optional(),
  pm_resolver: PmResolverConfigSchema.optional(),
  parallel_dispatch: ParallelDispatchConfigSchema.optional()
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
    const pmResolver = normalizePmResolverConfig(value.pm_resolver, userReplyChannels);
    const parallelDispatch = value.parallel_dispatch ?? {
      enabled: false,
      max_concurrency: 1
    };

    return {
      ...value,
      user_reply_channel: primaryReplyChannel ? cloneReplyChannel(primaryReplyChannel) : undefined,
      user_reply_channels: userReplyChannels,
      use_agent_dispatcher: value.use_agent_dispatcher ?? true,
      pm_resolver: pmResolver,
      parallel_dispatch: parallelDispatch
    };
});
export type AgentDispatcherConfig = z.infer<typeof AgentDispatcherConfigSchema>;

export const AgentDispatcherEditorConfigSchema = z.object({
  dispatch_plan_path: z.string().min(1),
  command_file_path: z.string().min(1),
  dispatch_repo_root: z.string().min(1),
  docs_root: z.string().min(1),
  user_reply_channels: z.array(ReplyChannelSchema).min(1),
  agent_type: AgentTypeSchema,
  model_id: z.string().min(1).optional(),
  // Mirrors AgentDispatcherConfigSchema.credential_id (PR #244). Without
  // this the GET /api/role/<id>/config response would reject a persisted
  // credential_id under .strict() — and the GUI's role-config form needs
  // the populated value to round-trip through Save (PR #246-followup).
  credential_id: z.string().min(1).optional(),
  mode: StatefulBridgeModeSchema,
  kill_policy: KillPolicySchema,
  auto_approve: z.boolean().default(false),
  validator: ValidatorConfigSchema.optional(),
  pm_resolver: PmResolverConfigSchema,
  parallel_dispatch: ParallelDispatchConfigSchema
}).strict();
export type AgentDispatcherEditorConfig = z.infer<typeof AgentDispatcherEditorConfigSchema>;

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

// ─── Scheduler role schemas ─────────────────────────────────────────────────

export const SchedulerModeSchema = z.enum(["none", "cron", "interval", "loop"]);
export type SchedulerMode = z.infer<typeof SchedulerModeSchema>;

export const ScanRunIdStrategySchema = z.enum(["none", "daily-date"]);
export type ScanRunIdStrategy = z.infer<typeof ScanRunIdStrategySchema>;

export const CatchUpPolicySchema = z.enum(["skip_missed", "run_one"]);
export type CatchUpPolicy = z.infer<typeof CatchUpPolicySchema>;

export const TerminalOutcomeSchema = z.enum([
  "completed",
  "completed_with_skips",
  "failed",
  "manual_intervention_required",
  "cancelled",
  "overlap_skipped"
]);
export type TerminalOutcome = z.infer<typeof TerminalOutcomeSchema>;

export const SchedulerStatusSchema = z.enum([
  "idle",
  "waiting",
  "active_run",
  "paused",
  "completed_max_cycles",
  "manual_intervention_required"
]);
export type SchedulerStatus = z.infer<typeof SchedulerStatusSchema>;

export const SchedulerConfigSchema = z.object({
  // ── Target dispatcher ──
  dispatch_plan_path: z.string().min(1),
  command_file_path: z.string().min(1),
  dispatch_repo_root: z.string().min(1).optional(),
  docs_root: z.string().min(1).optional(),
  user_reply_channels: z.array(ReplyChannelSchema).min(1),

  // ── Dispatcher agent settings (pass-through to child dispatcher) ──
  agent_type: AgentTypeSchema.default("claude"),
  model_id: z.string().min(1).optional(),
  credential_id: z.string().min(1).optional(),
  mode: StatefulBridgeModeSchema.default("bridge"),
  kill_policy: KillPolicySchema.default("always"),
  auto_approve: z.boolean().default(false),
  model_map: DispatchModelMapSchema.optional(),
  validator: ValidatorConfigSchema.optional(),
  pm_resolver: PmResolverConfigSchema.optional(),

  // ── Schedule config ──
  scheduler_mode: SchedulerModeSchema.default("none"),

  // Cron mode
  cron_expression: z.string().optional(),
  timezone: z.string().default("system"),

  // Interval mode
  interval_seconds: z.number().int().min(1).optional(),

  // Loop/Interval shared
  start_immediately: z.boolean().optional(),
  max_cycles: z.number().int().min(1).optional(),
  delay_between_cycles_seconds: z.number().int().min(0).default(0),

  // Routine job run identity
  scan_run_id_strategy: ScanRunIdStrategySchema.optional(),
  scan_run_id_prefix: z.string().min(1).optional(),

  // Archival
  report_base_dir: z.string().min(1),

  // Recovery
  catch_up_policy: CatchUpPolicySchema.default("skip_missed")
})
  .transform((value) => ({
    ...value,
    user_reply_channels: value.user_reply_channels.map(cloneReplyChannel),
    pm_resolver: normalizePmResolverConfig(value.pm_resolver, value.user_reply_channels)
  }));
export type SchedulerConfig = Omit<z.infer<typeof SchedulerConfigSchema>, "pm_resolver"> & {
  pm_resolver?: PmResolverConfig;
};

export const SchedulerRunWorkerSummarySchema = z.object({
  worker_id: z.string().min(1),
  status: z.string().min(1),
  thread_id: z.string().min(1).optional(),
  retry_count: z.number().int().min(0).default(0),
  report_path: z.string().optional()
});
export type SchedulerRunWorkerSummary = z.infer<typeof SchedulerRunWorkerSummarySchema>;

export const SchedulerRunSummarySchema = z.object({
  run_id: z.string().min(1),
  scheduler_mode: SchedulerModeSchema,
  planned_start_time: z.string().datetime().nullable(),
  actual_start_time: z.string().datetime(),
  completed_time: z.string().datetime().nullable(),
  duration_seconds: z.number().nullable(),
  dispatcher_thread_id: z.string().min(1).nullable(),
  terminal_outcome: TerminalOutcomeSchema.nullable(),
  workers: z.array(SchedulerRunWorkerSummarySchema).default([])
});
export type SchedulerRunSummary = z.infer<typeof SchedulerRunSummarySchema>;

export const SchedulerRunStateSchema = z.object({
  status: SchedulerStatusSchema.default("idle"),
  current_run_id: z.string().nullable().default(null),
  current_run_report_dir: z.string().nullable().default(null),
  current_scan_run_id: z.string().nullable().default(null),
  current_dispatcher_thread_id: z.string().nullable().default(null),
  current_run_planned_start_time: z.string().datetime().nullable().default(null),
  current_run_actual_start_time: z.string().datetime().nullable().default(null),
  completed_cycles: z.number().int().min(0).default(0),
  next_run_at: z.string().nullable().default(null),
  last_run_completed_at: z.string().nullable().default(null),
  last_run_outcome: TerminalOutcomeSchema.nullable().default(null),
  last_report_path: z.string().nullable().default(null),
  plan_lock_owner: z.string().nullable().default(null),
  run_history: z.array(SchedulerRunSummarySchema).default([])
});
export type SchedulerRunState = z.infer<typeof SchedulerRunStateSchema>;

function cloneReplyChannel(replyChannel: ReplyChannel): ReplyChannel {
  return { ...replyChannel };
}

function normalizePmResolverConfig(
  value: PmResolverConfig | undefined,
  inheritedReplyChannels: ReplyChannel[]
): PmResolverConfig {
  const parsed = PmResolverConfigSchema.parse(value ?? {});
  const replyChannels = parsed.user_reply_channels?.map(cloneReplyChannel)
    ?? inheritedReplyChannels.map(cloneReplyChannel);

  return {
    ...parsed,
    user_reply_channels: replyChannels
  };
}

export const ChatterTemplateNameSchema = z.enum(["flat-log", "topic-tree", "indexed-kb"]);
export type ChatterTemplateName = z.infer<typeof ChatterTemplateNameSchema>;

export const ChatterAllowedModesSchema = z.array(z.enum(["stateless", "session"])).min(1);

export const ChatterSeedsInitSchema = z
  .object({
    mode: z.enum(["copy_on_provision"]),
    source_path: z.string().min(1).optional()
  })
  .strict();
export type ChatterSeedsInit = z.infer<typeof ChatterSeedsInitSchema>;

export const ChatterRoleConfigSchema = z.object({
  chatter_id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/i, "chatter_id must be slug-like"),
  memory_folder: z.string().refine((p) => p.startsWith("/"), "memory_folder must be an absolute path"),
  template: ChatterTemplateNameSchema.optional(),
  manifest_path: z.string().refine((p) => p.startsWith("/"), "manifest_path must be absolute").optional(),
  allowed_modes: ChatterAllowedModesSchema,
  skill_allowlist: z.array(z.string().min(1)).default([]),
  // Optional project binding. When set, the chatter resolves the matching
  // project SkillManifest at activate time and registers each allowlisted
  // skill (intersection of `skill_allowlist` and the manifest) into the
  // dispatch map. Existing operator-provisioned chatters (which only use
  // structured.* + chatter.* skills) omit this field and keep working
  // unchanged — see `src/roles/chatter/skills/project-scoped/`.
  project_id: z.string().min(1).optional(),
  // llm_agent_kind is intentionally unconstrained here: chatter is just a
  // thin pass-through to meridian-hub's spawn boundary, and the list of
  // accepted kinds is owned by meridian-hub (surfaced to the GUI via
  // `GET /api/agent-kinds`). Hub-side spawn rejects unknown kinds, so a
  // zod enum in chatter would only drift out of sync. The default keeps
  // existing single-option callers backwards-compatible.
  llm_agent_kind: z.string().min(1).default("claude-code"),
  // Optional model the operator wants chatter to forward to the agent
  // spawn. Free-form for the same reason as `llm_agent_kind`: meridian-hub
  // owns the allowed list per kind and surfaces it via /api/agent-kinds.
  llm_model: z.string().min(1).optional(),
  // Optional managed-credential binding. When set, ChatterRole forwards it
  // on outbound hub messages as `payload.credential_id`, which meridian-hub
  // honors at spawn time to bind the agent process to a specific
  // CODEX_HOME (per PR #78). Flat-role pattern, mirrors SchedulerConfig.
  credential_id: z.string().min(1).optional(),
  seeds_init: ChatterSeedsInitSchema.optional(),
  // Required: ChatterRole has no useful behavior without somewhere to reply.
  // Operators provide one channel at init; the gateway (ADS) demuxes per-user
  // on its end via session correlation in payload.chatter.
  user_reply_channel: ReplyChannelSchema
}).refine((v) => v.template !== undefined || v.manifest_path !== undefined, {
  message: "Either template or manifest_path must be provided"
});
export type ChatterRoleConfig = z.infer<typeof ChatterRoleConfigSchema>;
