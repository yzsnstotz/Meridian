import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { isApprovalPrompt, normalizeApprovalAction, parseApprovalSummaryFromRawContent } from "../shared/approval";
import { AgentInstanceSchema, type AgentInstance } from "../types";

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
  replace_key: z.string().min(1).nullable().default(null)
});

const LegacyPersistedHubStateSchema = z.object({
  version: z.literal(1),
  updated_at: z.string().datetime(),
  instances: z.array(AgentInstanceSchema).default([]),
  session_bindings: z.record(z.string(), z.string().min(1)).default({}),
  push_subscriptions: z.record(z.string(), z.array(PersistedPushSubscriptionSchema)).default({}),
  conversation_history: z.record(z.string(), z.array(LegacyPersistedConversationHistoryEntrySchema)).default({})
});

const PersistedHubStateSchema = z.object({
  version: z.literal(2),
  updated_at: z.string().datetime(),
  instances: z.array(AgentInstanceSchema).default([]),
  session_bindings: z.record(z.string(), z.string().min(1)).default({}),
  push_subscriptions: z.record(z.string(), z.array(PersistedPushSubscriptionSchema)).default({}),
  conversation_history: z.record(z.string(), z.array(PersistedConversationHistoryEntrySchema)).default({})
});

type LegacyPersistedHubState = z.input<typeof LegacyPersistedHubStateSchema>;
type LegacyPersistedConversationHistoryEntry = z.input<typeof LegacyPersistedConversationHistoryEntrySchema>;

export type PersistedHubState = z.input<typeof PersistedHubStateSchema>;
export type PersistedPushSubscription = z.input<typeof PersistedPushSubscriptionSchema>;
export type PersistedConversationHistoryEntry = z.input<typeof PersistedConversationHistoryEntrySchema>;

function buildReplaceKey(
  threadId: string,
  traceId: string | null,
  eventKind: Extract<ConversationEventKind, "progress" | "approval">
): string {
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
          if (existing.trace_id === entry.trace_id && (existing.event_kind === "progress" || existing.event_kind === "approval")) {
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
    version: 2,
    updated_at: state.updated_at,
    instances: state.instances,
    session_bindings: state.session_bindings,
    push_subscriptions: state.push_subscriptions,
    conversation_history: migrateLegacyConversationHistory(state.conversation_history)
  });
}

export function buildEmptyPersistedHubState(nowIso: string): PersistedHubState {
  return {
    version: 2,
    updated_at: nowIso,
    instances: [],
    session_bindings: {},
    push_subscriptions: {},
    conversation_history: {}
  };
}

export function buildPersistedHubState(
  nowIso: string,
  instances: AgentInstance[],
  sessionBindings: Record<string, string>,
  pushSubscriptions: Record<string, PersistedPushSubscription[]> = {},
  conversationHistory: Record<string, PersistedConversationHistoryEntry[]> = {}
): PersistedHubState {
  return PersistedHubStateSchema.parse({
    version: 2,
    updated_at: nowIso,
    instances,
    session_bindings: sessionBindings,
    push_subscriptions: pushSubscriptions,
    conversation_history: conversationHistory
  });
}

export function loadPersistedHubState(statePath: string, nowIso: string): PersistedHubState {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const current = PersistedHubStateSchema.safeParse(parsed);
    if (current.success) {
      return current.data;
    }
    const legacy = LegacyPersistedHubStateSchema.safeParse(parsed);
    if (legacy.success) {
      return migrateLegacyPersistedHubState(legacy.data);
    }
    return buildEmptyPersistedHubState(nowIso);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return buildEmptyPersistedHubState(nowIso);
    }
    return buildEmptyPersistedHubState(nowIso);
  }
}

export function savePersistedHubState(statePath: string, state: PersistedHubState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, statePath);
}
