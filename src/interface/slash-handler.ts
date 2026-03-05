import type { BridgeMode, Intent } from "../types";

type SlashIntent = Intent | "help";

export interface ParsedSlashCommand {
  intent: SlashIntent;
  shouldForward: boolean;
  target: string;
  threadId: string | null;
  mode: BridgeMode;
  payloadContent: string;
}

const HELP_MESSAGE = [
  "Available commands:",
  "/spawn type=<claude|codex|gemini|cursor> mode=<bridge|pane_bridge>",
  "/kill thread=<thread_id>",
  "/status thread=<thread_id>",
  "/attach thread=<thread_id>",
  "/list",
  "/help",
  "Free text messages are treated as run intent."
].join("\n");

const ALLOWED_AGENT_TYPES = new Set(["claude", "codex", "gemini", "cursor"]);

function parseKeyValueArgs(rawArgs: string): Record<string, string> {
  if (!rawArgs.trim()) {
    return {};
  }

  const args: Record<string, string> = {};
  for (const token of rawArgs.trim().split(/\s+/)) {
    const separatorIndex = token.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }

    const key = token.slice(0, separatorIndex).trim().toLowerCase();
    const value = token.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      continue;
    }
    args[key] = value;
  }
  return args;
}

function parseMode(rawMode: string | undefined): BridgeMode {
  if (!rawMode) {
    return "bridge";
  }
  if (rawMode === "bridge" || rawMode === "pane_bridge") {
    return rawMode;
  }
  throw new Error("mode must be bridge or pane_bridge");
}

function requireThreadId(args: Record<string, string>, commandName: string): string {
  const thread = args.thread;
  if (!thread || thread.trim().length === 0) {
    throw new Error(`${commandName} requires thread=<thread_id>`);
  }
  return thread.trim();
}

export function getHelpMessage(): string {
  return HELP_MESSAGE;
}

export function parseSlashCommand(rawContent: string): ParsedSlashCommand {
  const content = rawContent.trim();

  if (!content.startsWith("/")) {
    return {
      intent: "run",
      shouldForward: true,
      target: "active",
      threadId: null,
      mode: "bridge",
      payloadContent: content
    };
  }

  const [rawCommand, ...restTokens] = content.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();
  const rawArgs = restTokens.join(" ");
  const args = parseKeyValueArgs(rawArgs);

  switch (command) {
    case "/spawn": {
      const rawType = (args.type ?? "codex").toLowerCase();
      if (!ALLOWED_AGENT_TYPES.has(rawType)) {
        throw new Error("spawn type must be one of claude|codex|gemini|cursor");
      }

      return {
        intent: "spawn",
        shouldForward: true,
        target: rawType,
        threadId: args.thread ?? null,
        mode: parseMode(args.mode),
        payloadContent: rawArgs
      };
    }

    case "/kill": {
      const threadId = requireThreadId(args, "/kill");
      return {
        intent: "kill",
        shouldForward: true,
        target: threadId,
        threadId,
        mode: "bridge",
        payloadContent: rawArgs
      };
    }

    case "/status": {
      const threadId = requireThreadId(args, "/status");
      return {
        intent: "status",
        shouldForward: true,
        target: threadId,
        threadId,
        mode: "bridge",
        payloadContent: rawArgs
      };
    }

    case "/attach": {
      const threadId = requireThreadId(args, "/attach");
      return {
        intent: "attach",
        shouldForward: true,
        target: threadId,
        threadId,
        mode: "bridge",
        payloadContent: rawArgs
      };
    }

    case "/list":
      return {
        intent: "list",
        shouldForward: true,
        target: "all",
        threadId: null,
        mode: "bridge",
        payloadContent: ""
      };

    case "/help":
      return {
        intent: "help",
        shouldForward: false,
        target: "none",
        threadId: null,
        mode: "bridge",
        payloadContent: ""
      };

    default:
      throw new Error(`Unsupported command: ${command}. Use /help for usage.`);
  }
}
