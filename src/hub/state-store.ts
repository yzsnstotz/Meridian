import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { isApprovalPrompt, normalizeApprovalAction, parseApprovalSummaryFromRawContent } from "../shared/approval";
import { AgentInstanceSchema, CallerAuthoritySchema, type AgentInstance } from "../types";

export const CallerRecordSchema = z.object({
  caller_id: z.string().min(1),
  caller_label: z.string().min(1),
  caller_kind: z.enum(["builtin", "external"]),
  caller_authority: CallerAuthoritySchema.default("write"),
  key_hash: z.string().min(1),
  created_at: z.string().datetime(),
  last_seen_at: z.string().datetime().nullable(),
  revoked_at: z.string().datetime().nullable()
});
export type CallerRecord = z.input<typeof CallerRecordSchema>;

const PersistedPushSubscriptionSchema = z.object({
  session_id: z.string().min(1),
  chat_id: z.string().min(1),
  bot_id: z.string().regex(/^\d+$/).nullable().optional()
});

export const ConversationEventKindSchema = z.enum(["user_send", "terminal_input", "progress", "approval", "final_reply"]);
export type ConversationEventKind = z.infer<typeof ConversationEventKindSchema>;

const LegacyPersistedConversationHistoryEntrySchema = z.object({
  id: z.string().min(1),
  type: z.enum(["user", "agent"]),
  content: z.string(),
  details_text: z.string().default(""),
  raw_content: z.string().default(""),
  trace_id: z.string().uuid().nullable().default(null),
  timestamp: z.string().datetime()
});

const PersistedConversationHistoryEntryV2Schema = z.object({
  id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  event_kind: ConversationEventKindSchema,
  source: z.string().min(1),
  content: z.string(),
  details_text: z.string().default(""),
  raw_content: z.string().default(""),
  trace_id: z.string().uuid().nullable().default(null),
  timestamp: z.string().datetime(),
  replace_key: z.string().min(1).nullable().default(null)
});

const PersistedConversationHistoryEntrySchema = z.object({
  id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  event_kind: ConversationEventKindSchema,
  source: z.string().min(1),
  content: z.string(),
  details_text: z.string().default(""),
  raw_content: z.string().default(""),
  trace_id: z.string().uuid().nullable().default(null),
  timestamp: z.string().datetime(),
  replace_key: z.string().min(1).nullable().default(null),
  caller_id: z.string().min(1).nullable().default(null),
  caller_label: z.string().min(1).nullable().default(null)
});

const LegacyPersistedHubStateSchema = z.object({
  version: z.literal(1),
  updated_at: z.string().datetime(),
  instances: z.array(AgentInstanceSchema).default([]),
  session_bindings: z.record(z.string(), z.string().min(1)).default({}),
  push_subscriptions: z.record(z.string(), z.array(PersistedPushSubscriptionSchema)).default({}),
  conversation_history: z.record(z.string(), z.array(LegacyPersistedConversationHistoryEntrySchema)).default({})
});

const PersistedHubStateV2Schema = z.object({
  version: z.literal(2),
  updated_at: z.string().datetime(),
  instances: z.array(AgentInstanceSchema).default([]),
  session_bindings: z.record(z.string(), z.string().min(1)).default({}),
  push_subscriptions: z.record(z.string(), z.array(PersistedPushSubscriptionSchema)).default({}),
  conversation_history: z.record(z.string(), z.array(PersistedConversationHistoryEntryV2Schema)).default({})
});

const PersistedHubStateSchema = z.object({
  version: z.literal(3),
  updated_at: z.string().datetime(),
  instances: z.array(AgentInstanceSchema).default([]),
  session_bindings: z.record(z.string(), z.string().min(1)).default({}),
  push_subscriptions: z.record(z.string(), z.array(PersistedPushSubscriptionSchema)).default({}),
  conversation_history: z.record(z.string(), z.array(PersistedConversationHistoryEntrySchema)).default({}),
  callers: z.array(CallerRecordSchema).default([])
});

type LegacyPersistedHubState = z.input<typeof LegacyPersistedHubStateSchema>;
type LegacyPersistedConversationHistoryEntry = z.input<typeof LegacyPersistedConversationHistoryEntrySchema>;
type PersistedHubStateV2 = z.input<typeof PersistedHubStateV2Schema>;

export type PersistedHubState = z.input<typeof PersistedHubStateSchema>;
export type PersistedPushSubscription = z.input<typeof PersistedPushSubscriptionSchema>;
export type PersistedConversationHistoryEntry = z.input<typeof PersistedConversationHistoryEntrySchema>;

function isSupersededByFinalReplyEventKind(eventKind: ConversationEventKind): eventKind is "progress" {
  return eventKind === "progress";
}

function buildReplaceKey(
  threadId: string,
  traceId: string | null,
  eventKind: Extract<ConversationEventKind, "progress" | "approval">
): string | null {
  if (eventKind !== "approval") {
    return null;
  }

  return traceId ? `${traceId}:${eventKind}` : `${threadId}:${eventKind}`;
}

function inferLegacyEventKind(
  threadId: string,
  entry: LegacyPersistedConversationHistoryEntry,
  index: number,
  entries: LegacyPersistedConversationHistoryEntry[]
): ConversationEventKind {
  if (entry.type === "user") {
    return normalizeApprovalAction(entry.content) ? "terminal_input" : "user_send";
  }

  const approvalSummary = parseApprovalSummaryFromRawContent(entry.raw_content || entry.details_text || entry.content);
  if (approvalSummary || isApprovalPrompt(entry.content)) {
    return "approval";
  }

  if (!entry.trace_id) {
    return "final_reply";
  }

  const laterAgentWithSameTrace = entries.slice(index + 1).some((candidate) => {
    return candidate.type === "agent" && candidate.trace_id === entry.trace_id;
  });

  return laterAgentWithSameTrace ? "progress" : "final_reply";
}

function migrateLegacyConversationHistory(
  legacyHistory: LegacyPersistedHubState["conversation_history"]
): PersistedHubState["conversation_history"] {
  const migrated: PersistedHubState["conversation_history"] = {};

  for (const [threadId, entries] of Object.entries(legacyHistory ?? {})) {
    const nextEntries: PersistedConversationHistoryEntry[] = [];
    let nextSequence = 1;

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) {
        continue;
      }

      const eventKind = inferLegacyEventKind(threadId, entry, index, entries);
      const replaceKey =
        eventKind === "progress" || eventKind === "approval"
          ? buildReplaceKey(threadId, entry.trace_id ?? null, eventKind)
          : null;

      if (eventKind === "final_reply" && entry.trace_id) {
        for (let migratedIndex = nextEntries.length - 1; migratedIndex >= 0; migratedIndex -= 1) {
          const existing = nextEntries[migratedIndex];
          if (!existing) {
            continue;
          }
          if (existing.trace_id === entry.trace_id && isSupersededByFinalReplyEventKind(existing.event_kind)) {
            nextEntries.splice(migratedIndex, 1);
          }
        }
      }

      if (replaceKey) {
        const existing = nextEntries.find((candidate) => candidate.replace_key === replaceKey);
        if (existing) {
          existing.content = entry.content;
          existing.details_text = entry.details_text ?? "";
          existing.raw_content = entry.raw_content ?? entry.details_text ?? entry.content;
          existing.timestamp = entry.timestamp;
          continue;
        }
      }

      nextEntries.push({
        id: entry.id,
        sequence: nextSequence,
        event_kind: eventKind,
        source: entry.type === "user" ? "user" : "legacy",
        content: entry.content,
        details_text: entry.details_text ?? "",
        raw_content: entry.raw_content ?? entry.details_text ?? entry.content,
        trace_id: entry.trace_id ?? null,
        timestamp: entry.timestamp,
        replace_key: replaceKey
      });
      nextSequence += 1;
    }

    if (nextEntries.length > 0) {
      migrated[threadId] = nextEntries;
    }
  }

  return migrated;
}

function migrateLegacyPersistedHubState(state: LegacyPersistedHubState): PersistedHubState {
  return PersistedHubStateSchema.parse({
    version: 3,
    updated_at: state.updated_at,
    instances: state.instances,
    session_bindings: state.session_bindings,
    push_subscriptions: state.push_subscriptions,
    conversation_history: migrateLegacyConversationHistory(state.conversation_history),
    callers: []
  });
}

function migrateConversationHistoryV2EntriesToV3(
  v2History: PersistedHubStateV2["conversation_history"]
): PersistedHubState["conversation_history"] {
  const result: PersistedHubState["conversation_history"] = {};
  for (const [threadId, entries] of Object.entries(v2History ?? {})) {
    result[threadId] = (entries ?? []).map((entry) => ({
      ...entry,
      caller_id: null,
      caller_label: null
    }));
  }
  return result;
}

export function migrateLegacyConversationHistoryV2ToV3(state: unknown): PersistedHubState {
  const asV3 = PersistedHubStateSchema.safeParse(state);
  if (asV3.success) {
    return asV3.data;
  }
  const asV2 = PersistedHubStateV2Schema.safeParse(state);
  if (!asV2.success) {
    throw new Error("invalid_state_for_v2_to_v3_migration");
  }
  return PersistedHubStateSchema.parse({
    version: 3,
    updated_at: asV2.data.updated_at,
    instances: asV2.data.instances,
    session_bindings: asV2.data.session_bindings,
    push_subscriptions: asV2.data.push_subscriptions,
    conversation_history: migrateConversationHistoryV2EntriesToV3(asV2.data.conversation_history),
    callers: []
  });
}

const LegacyCallerKeyEntrySchema = z.object({
  caller_id: z.string().min(1),
  caller_label: z.string().min(1),
  caller_key: z.string().min(1)
});

function seedCallersFromLegacyEnv(rawJson: string, nowIso: string): CallerRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }
  const validated = z.array(LegacyCallerKeyEntrySchema).safeParse(parsed);
  if (!validated.success) {
    return [];
  }
  return validated.data.map((entry) => ({
    caller_id: entry.caller_id,
    caller_label: entry.caller_label,
    caller_kind: "external" as const,
    caller_authority: "write" as const,
    key_hash: crypto.createHash("sha256").update(entry.caller_key + entry.caller_id).digest("hex"),
    created_at: nowIso,
    last_seen_at: null,
    revoked_at: null
  }));
}

export function buildEmptyPersistedHubState(nowIso: string): PersistedHubState {
  return {
    version: 3,
    updated_at: nowIso,
    instances: [],
    session_bindings: {},
    push_subscriptions: {},
    conversation_history: {},
    callers: []
  };
}

export function buildPersistedHubState(
  nowIso: string,
  instances: AgentInstance[],
  sessionBindings: Record<string, string>,
  pushSubscriptions: Record<string, PersistedPushSubscription[]> = {},
  conversationHistory: Record<string, PersistedConversationHistoryEntry[]> = {},
  callers: CallerRecord[] = []
): PersistedHubState {
  return PersistedHubStateSchema.parse({
    version: 3,
    updated_at: nowIso,
    instances,
    session_bindings: sessionBindings,
    push_subscriptions: pushSubscriptions,
    conversation_history: conversationHistory,
    callers
  });
}

function loadAndMigrate(statePath: string, nowIso: string): PersistedHubState {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const v3 = PersistedHubStateSchema.safeParse(parsed);
    if (v3.success) {
      return v3.data;
    }
    const v2 = PersistedHubStateV2Schema.safeParse(parsed);
    if (v2.success) {
      return migrateLegacyConversationHistoryV2ToV3(v2.data);
    }
    const v1 = LegacyPersistedHubStateSchema.safeParse(parsed);
    if (v1.success) {
      return migrateLegacyPersistedHubState(v1.data);
    }
    return buildEmptyPersistedHubState(nowIso);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return buildEmptyPersistedHubState(nowIso);
    }
    return buildEmptyPersistedHubState(nowIso);
  }
}

export function loadPersistedHubState(statePath: string, nowIso: string): PersistedHubState {
  let state = loadAndMigrate(statePath, nowIso);

  if ((state.callers?.length ?? 0) === 0 && process.env.MERIDIAN_CALLER_KEYS) {
    const seeded = seedCallersFromLegacyEnv(process.env.MERIDIAN_CALLER_KEYS, nowIso);
    if (seeded.length > 0) {
      state = PersistedHubStateSchema.parse({
        ...state,
        callers: seeded,
        updated_at: nowIso
      });
      try {
        savePersistedHubState(statePath, state);
      } catch {
        // Persisting the seed is best-effort. If it fails, the next boot will
        // re-seed from the same env var, producing identical key_hash values.
      }
    }
  }

  return state;
}

export function savePersistedHubState(statePath: string, state: PersistedHubState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, statePath);
}
