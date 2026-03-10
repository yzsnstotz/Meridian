import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { AgentInstanceSchema, type AgentInstance } from "../types";

const PersistedPushSubscriptionSchema = z.object({
  session_id: z.string().min(1),
  chat_id: z.string().min(1),
  bot_id: z.string().regex(/^\d+$/).nullable().optional()
});

const PersistedConversationHistoryEntrySchema = z.object({
  id: z.string().min(1),
  type: z.enum(["user", "agent"]),
  content: z.string(),
  details_text: z.string().default(""),
  raw_content: z.string().default(""),
  trace_id: z.string().uuid().nullable().default(null),
  timestamp: z.string().datetime()
});

const PersistedHubStateSchema = z.object({
  version: z.literal(1),
  updated_at: z.string().datetime(),
  instances: z.array(AgentInstanceSchema).default([]),
  session_bindings: z.record(z.string(), z.string().min(1)).default({}),
  push_subscriptions: z.record(z.string(), z.array(PersistedPushSubscriptionSchema)).default({}),
  conversation_history: z.record(z.string(), z.array(PersistedConversationHistoryEntrySchema)).default({})
});

export type PersistedHubState = z.input<typeof PersistedHubStateSchema>;
export type PersistedPushSubscription = z.input<typeof PersistedPushSubscriptionSchema>;
export type PersistedConversationHistoryEntry = z.input<typeof PersistedConversationHistoryEntrySchema>;

export function buildEmptyPersistedHubState(nowIso: string): PersistedHubState {
  return {
    version: 1,
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
    version: 1,
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
    return PersistedHubStateSchema.parse(JSON.parse(raw));
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
