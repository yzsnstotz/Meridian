import { randomUUID } from "node:crypto";

import { HubMessageSchema, type BridgeMode, type HubMessage, type InboundUIEvent, type Intent } from "../types";

interface ParsedIntent {
  intent: Intent;
  target: string;
  threadId: string;
  spawnDir: string | null;
  mode: BridgeMode;
  payloadContent: string;
}

export interface NormalizerContext {
  chatId: string;
  actorId?: string;
  defaultThreadId?: string;
}

const AGENT_TYPE_SET = new Set(["claude", "codex", "gemini", "cursor"]);
const ARG_KEYS = new Set(["type", "mode", "thread", "dir", "repo"]);

function parseKeyValueArgs(rawArgs: string): Record<string, string> {
  const normalized = rawArgs.replace(/[＝:：]/g, "=").replace(/\s*=\s*/g, "=").trim();
  const args: Record<string, string> = {};
  const tokens = normalized ? normalized.split(/\s+/) : [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const separatorIndex = token.indexOf("=");
    if (separatorIndex < 0) {
      const next = tokens[index + 1];
      const keyCandidate = token.trim().toLowerCase();
      if (ARG_KEYS.has(keyCandidate) && next && !next.includes("=")) {
        args[keyCandidate] = next.trim();
        index += 1;
      }
      continue;
    }
    const key = token.slice(0, separatorIndex).toLowerCase();
    const value = token.slice(separatorIndex + 1);
    if (!key || !value) {
      continue;
    }
    args[key] = value;
  }
  return args;
}

function resolveMode(mode: string | undefined): BridgeMode {
  if (mode === undefined || mode === "bridge" || mode === "pane_bridge") {
    return mode ?? "bridge";
  }
  throw new Error("mode must be bridge or pane_bridge");
}

function requireThreadId(args: Record<string, string>, fallbackThreadId: string, command: string): string {
  const threadId = args.thread?.trim() || fallbackThreadId;
  if (!threadId) {
    throw new Error(`${command} requires thread=<thread_id>`);
  }
  return threadId;
}

function parseIntent(content: string, fallbackThreadId: string): ParsedIntent {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) {
    return {
      intent: "run",
      target: fallbackThreadId || "active",
      threadId: fallbackThreadId || "unbound",
      spawnDir: null,
      mode: "bridge",
      payloadContent: trimmed
    };
  }

  const [rawCommand, ...restTokens] = trimmed.split(/\s+/);
  const command = rawCommand.split("@")[0]?.toLowerCase();
  const rawArgs = restTokens.join(" ");
  const args = parseKeyValueArgs(rawArgs);

  switch (command) {
    case "/spawn": {
      const type = (args.type ?? "codex").toLowerCase();
      if (!AGENT_TYPE_SET.has(type)) {
        throw new Error("spawn type must be one of claude|codex|gemini|cursor");
      }
      const threadId = args.thread ?? "pending";
      return {
        intent: "spawn",
        target: type,
        threadId,
        spawnDir: args.dir?.trim() || args.repo?.trim() || null,
        mode: resolveMode(args.mode),
        payloadContent: rawArgs
      };
    }

    case "/kill": {
      const threadId = requireThreadId(args, fallbackThreadId, "/kill");
      return { intent: "kill", target: threadId, threadId, spawnDir: null, mode: "bridge", payloadContent: rawArgs };
    }

    case "/status": {
      const threadId = requireThreadId(args, fallbackThreadId, "/status");
      return { intent: "status", target: threadId, threadId, spawnDir: null, mode: "bridge", payloadContent: rawArgs };
    }

    case "/attach": {
      const threadId = requireThreadId(args, fallbackThreadId, "/attach");
      return { intent: "attach", target: threadId, threadId, spawnDir: null, mode: "bridge", payloadContent: rawArgs };
    }

    case "/model": {
      const threadId = requireThreadId(args, fallbackThreadId, "/model");
      const type = (args.type ?? "").trim().toLowerCase();
      if (!AGENT_TYPE_SET.has(type)) {
        throw new Error("model type must be one of claude|codex|gemini|cursor");
      }
      return { intent: "switch_model", target: type, threadId, spawnDir: null, mode: "bridge", payloadContent: rawArgs };
    }

    case "/list":
      return {
        intent: "list",
        target: "all",
        threadId: "global",
        spawnDir: null,
        mode: "bridge",
        payloadContent: ""
      };

    case "/help":
      throw new Error("/help is an interface-only command and should not be routed to hub");

    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

export function normalizeInboundEvent(event: InboundUIEvent, context: NormalizerContext): HubMessage {
  const fallbackThreadId = context.defaultThreadId ?? event.reply_to ?? "";
  const parsed = parseIntent(event.content, fallbackThreadId);

  return HubMessageSchema.parse({
    trace_id: randomUUID(),
    thread_id: parsed.threadId,
    actor_id: context.actorId ?? "owner",
    intent: parsed.intent,
    target: parsed.target,
    payload: {
      content: parsed.payloadContent || event.content,
      attachments: event.attachments,
      raw_message_id: event.raw_message_id,
      reply_to: event.reply_to,
      spawn_dir: parsed.spawnDir ?? undefined
    },
    mode: parsed.mode,
    reply_channel: {
      channel: "telegram",
      chat_id: context.chatId,
      message_id: event.raw_message_id
    }
  });
}
