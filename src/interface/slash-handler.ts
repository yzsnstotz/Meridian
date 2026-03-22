import type { BridgeMode, Intent } from "../types";
import { APPROVAL_HELP_TEXT, normalizeApprovalSelection } from "../shared/approval";

type SlashIntent = Intent | "help" | "service_restart" | "browse";
type PickerIntent = "spawn" | "attach" | "kill" | "switch_model";

export interface ParsedSlashCommand {
  intent: SlashIntent;
  shouldForward: boolean;
  target: string;
  threadId: string | null;
  spawnDir: string | null;
  monitorUpdatesEnabled: boolean | null;
  monitorUpdateIntervalSec: number | null;
  pushEnabled: boolean | null;
  mode: BridgeMode;
  payloadContent: string;
  picker: PickerIntent | null;
  priority: number | null;
  autoApproveValue: boolean | null;
  autoApproveQuery: boolean;
}

const HELP_MESSAGE = [
  "Available commands:",
  "/spawn type=<claude|codex|gemini|cursor> mode=<bridge|pane_bridge> [dir=<absolute_path>]",
  "/restart Rebuild and restart Meridian service",
  "/browse",
  "/kill thread=<thread_id>",
  "/info",
  "/status thread=<thread_id>",
  "/attach [thread=<thread_id>]",
  "/detach [thread=<thread_id>]",
  "/reboot thread=<thread_id>",
  "/gui [thread=<thread_id>]",
  "/approve <run|allow|all|skip|number> [thread=<thread_id>]",
  "/autoapprove on|off|status [thread=<thread_id>]",
  "/model",
  "/model [thread=<thread_id>]",
  "/detail [trace=<trace_id>] [thread=<thread_id>]",
  "/update [on|off] [thread=<thread_id>] [interval=<seconds>]",
  "/push [on|off] [thread=<thread_id>]",
  "/mupdate [thread=<thread_id>]",
  "/list",
  "/help",
  APPROVAL_HELP_TEXT,
  "Free text messages are treated as run intent."
].join("\n");

const ALLOWED_AGENT_TYPES = new Set(["claude", "codex", "gemini", "cursor"]);
const ALT_SLASH_PREFIXES = new Set(["／", "⁄", "∕"]);
const ARG_KEYS = new Set([
  "type",
  "mode",
  "thread",
  "dir",
  "repo",
  "state",
  "interval",
  "every",
  "sec",
  "seconds",
  "action"
]);

function parseKeyValueArgs(rawArgs: string): Record<string, string> {
  if (!rawArgs.trim()) {
    return {};
  }

  const normalized = rawArgs.replace(/[＝:：]/g, "=").replace(/\s*=\s*/g, "=").trim();
  const args: Record<string, string> = {};
  const tokens = normalized.split(/\s+/);
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

function parseMonitorUpdateSwitch(value: string | undefined): boolean | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "on") {
    return true;
  }
  if (normalized === "off") {
    return false;
  }
  throw new Error("/update state must be on or off");
}

function parsePositiveInteger(value: string, field: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${field} must be a positive integer`);
  }
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

function parseApprovalCommand(rawArgs: string, args: Record<string, string>, restTokens: string[]): string {
  const bareAction = restTokens.find((token) => !token.includes("=")) ?? "";
  const rawAction = (args.action ?? bareAction ?? rawArgs).trim();
  const action = normalizeApprovalSelection(rawAction);
  if (!action) {
    throw new Error(`/approve action is invalid. ${APPROVAL_HELP_TEXT}`);
  }
  return action;
}

function createParsedSlashCommand(
  command: Omit<ParsedSlashCommand, "autoApproveValue" | "autoApproveQuery"> &
    Partial<Pick<ParsedSlashCommand, "autoApproveValue" | "autoApproveQuery">>
): ParsedSlashCommand {
  return {
    autoApproveValue: null,
    autoApproveQuery: false,
    ...command
  };
}

function parseAutoApproveCommand(
  args: Record<string, string>,
  restTokens: string[]
): Pick<ParsedSlashCommand, "intent" | "payloadContent" | "autoApproveValue" | "autoApproveQuery"> {
  const bareAction = restTokens.find((token) => !token.includes("="))?.trim().toLowerCase() ?? "";
  const action = (args.action ?? bareAction).trim().toLowerCase();
  if (action === "on") {
    return {
      intent: "set_auto_approve",
      payloadContent: "on",
      autoApproveValue: true,
      autoApproveQuery: false
    };
  }
  if (action === "off") {
    return {
      intent: "set_auto_approve",
      payloadContent: "off",
      autoApproveValue: false,
      autoApproveQuery: false
    };
  }
  if (action === "status") {
    return {
      intent: "status",
      payloadContent: "status",
      autoApproveValue: null,
      autoApproveQuery: true
    };
  }
  throw new Error("/autoapprove action must be on, off, or status");
}

export function getHelpMessage(): string {
  return HELP_MESSAGE;
}

export function parseSlashCommand(rawContent: string): ParsedSlashCommand {
  const content = normalizeCommandPrefix(rawContent.trim());

  if (!content.startsWith("/")) {
    return createParsedSlashCommand({
      intent: "run",
      shouldForward: true,
      target: "active",
      threadId: null,
      spawnDir: null,
      monitorUpdatesEnabled: null,
      monitorUpdateIntervalSec: null,
      pushEnabled: null,
      mode: "bridge",
      payloadContent: content,
      picker: null,
      priority: null
    });
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

      return createParsedSlashCommand({
        intent: "spawn",
        shouldForward: true,
        target: rawType,
        threadId: args.thread ?? null,
        spawnDir: args.dir?.trim() || args.repo?.trim() || null,
        monitorUpdatesEnabled: null,
        monitorUpdateIntervalSec: null,
        pushEnabled: null,
        mode: parseMode(args.mode),
        payloadContent: rawArgs,
        picker: rawArgs.trim().length === 0 ? "spawn" : null,
        priority: null
      });
    }

    case "/kill": {
      const threadId = args.thread?.trim() || null;
      return createParsedSlashCommand({
        intent: "kill",
        shouldForward: true,
        target: threadId ?? "active",
        threadId,
        spawnDir: null,
        monitorUpdatesEnabled: null,
        monitorUpdateIntervalSec: null,
        pushEnabled: null,
        mode: "bridge",
        payloadContent: rawArgs,
        picker: threadId ? null : "kill",
        priority: 0
      });
    }

    case "/status": {
      const threadId = requireThreadId(args, "/status");
      return createParsedSlashCommand({
        intent: "status",
        shouldForward: true,
        target: threadId,
        threadId,
        spawnDir: null,
        monitorUpdatesEnabled: null,
        monitorUpdateIntervalSec: null,
        pushEnabled: null,
        mode: "bridge",
        payloadContent: rawArgs,
        picker: null,
        priority: null
      });
    }

    case "/info":
      return createParsedSlashCommand({
        intent: "status",
        shouldForward: true,
        target: "active",
        threadId: null,
        spawnDir: null,
        monitorUpdatesEnabled: null,
        monitorUpdateIntervalSec: null,
        pushEnabled: null,
        mode: "bridge",
        payloadContent: rawArgs,
        picker: null,
        priority: null
      });

    case "/attach": {
      const threadId = args.thread?.trim() || null;
      return createParsedSlashCommand({
        intent: "attach",
        shouldForward: true,
        target: threadId ?? "active",
        threadId,
        spawnDir: null,
        monitorUpdatesEnabled: null,
        monitorUpdateIntervalSec: null,
        pushEnabled: null,
        mode: "bridge",
        payloadContent: rawArgs,
        picker: threadId ? null : "attach",
        priority: null
      });
    }

    case "/detach": {
      const threadId = args.thread?.trim() || null;
      return createParsedSlashCommand({
        intent: "detach",
        shouldForward: true,
        target: threadId ?? "active",
        threadId,
        spawnDir: null,
        monitorUpdatesEnabled: null,
        monitorUpdateIntervalSec: null,
        pushEnabled: null,
        mode: "bridge",
        payloadContent: rawArgs,
        picker: null,
        priority: null
      });
    }

    case "/reboot": {
      const threadId = requireThreadId(args, "/reboot");
      return createParsedSlashCommand({
        intent: "reboot",
        shouldForward: true,
        target: threadId,
        threadId,
        spawnDir: null,
        monitorUpdatesEnabled: null,
        monitorUpdateIntervalSec: null,
        pushEnabled: null,
        mode: "bridge",
        payloadContent: rawArgs,
        picker: null,
        priority: 0
      });
    }

    case "/gui": {
      const threadId = args.thread?.trim() || null;
      return createParsedSlashCommand({
        intent: "gui",
        shouldForward: true,
        target: threadId ?? "active",
        threadId,
        spawnDir: null,
        monitorUpdatesEnabled: null,
        monitorUpdateIntervalSec: null,
        pushEnabled: null,
        mode: "bridge",
        payloadContent: rawArgs,
        picker: null,
        priority: null
      });
    }

    case "/approve": {
      const threadId = args.thread?.trim() || null;
      return createParsedSlashCommand({
        intent: "terminal_input",
        shouldForward: true,
        target: threadId ?? "active",
        threadId,
        spawnDir: null,
        monitorUpdatesEnabled: null,
        monitorUpdateIntervalSec: null,
        pushEnabled: null,
        mode: "bridge",
        payloadContent: parseApprovalCommand(rawArgs, args, restTokens),
        picker: null,
        priority: null
      });
    }

    case "/autoapprove": {
      const threadId = args.thread?.trim() || null;
      const parsed = parseAutoApproveCommand(args, restTokens);
      return createParsedSlashCommand({
        intent: parsed.intent,
        shouldForward: true,
        target: threadId ?? "active",
        threadId,
        spawnDir: null,
        monitorUpdatesEnabled: null,
        monitorUpdateIntervalSec: null,
        pushEnabled: null,
        mode: "bridge",
        payloadContent: parsed.payloadContent,
        picker: null,
        priority: null,
        autoApproveValue: parsed.autoApproveValue,
        autoApproveQuery: parsed.autoApproveQuery
      });
    }

    case "/model": {
      const threadId = args.thread?.trim() || null;
      return createParsedSlashCommand({
        intent: "switch_model",
        shouldForward: false,
        target: threadId ?? "active",
        threadId,
        spawnDir: null,
        monitorUpdatesEnabled: null,
        monitorUpdateIntervalSec: null,
        pushEnabled: null,
        mode: "bridge",
        payloadContent: "",
        picker: "switch_model",
        priority: null
      });
    }

    case "/detail": {
      const threadId = args.thread?.trim() || null;
      const traceId = args.trace?.trim() || "";
      return createParsedSlashCommand({
        intent: "detail",
        shouldForward: true,
        target: threadId ?? "active",
        threadId,
        spawnDir: null,
        monitorUpdatesEnabled: null,
        monitorUpdateIntervalSec: null,
        pushEnabled: null,
        mode: "bridge",
        payloadContent: traceId,
        picker: null,
        priority: null
      });
    }

    case "/update": {
      const bareStateToken = restTokens.find((token) => {
        const normalized = token.trim().toLowerCase();
        return normalized === "on" || normalized === "off";
      });
      const parsedState = parseMonitorUpdateSwitch(args.state ?? bareStateToken);
      const intervalCandidate =
        args.interval ??
        args.every ??
        args.sec ??
        args.seconds ??
        restTokens.find((token) => /^\d+$/.test(token.trim()));
      const parsedIntervalSec = intervalCandidate
        ? parsePositiveInteger(intervalCandidate, "/update interval")
        : null;
      const threadId = args.thread?.trim() || null;

      return createParsedSlashCommand({
        intent: "monitor_update",
        shouldForward: true,
        target: threadId ?? "active",
        threadId,
        spawnDir: null,
        monitorUpdatesEnabled: parsedState ?? (parsedIntervalSec ? true : null),
        monitorUpdateIntervalSec: parsedIntervalSec,
        pushEnabled: null,
        mode: "bridge",
        payloadContent: rawArgs,
        picker: null,
        priority: null
      });
    }

    case "/mupdate": {
      const threadId = args.thread?.trim() || null;
      return createParsedSlashCommand({
        intent: "monitor_manual_update",
        shouldForward: true,
        target: threadId ?? "active",
        threadId,
        spawnDir: null,
        monitorUpdatesEnabled: null,
        monitorUpdateIntervalSec: null,
        pushEnabled: null,
        mode: "bridge",
        payloadContent: rawArgs,
        picker: null,
        priority: null
      });
    }

    case "/push": {
      const bareStateToken = restTokens.find((token) => {
        const normalized = token.trim().toLowerCase();
        return normalized === "on" || normalized === "off";
      });
      const parsedState = parseMonitorUpdateSwitch(args.state ?? bareStateToken);
      const threadId = args.thread?.trim() || null;
      return createParsedSlashCommand({
        intent: "push",
        shouldForward: true,
        target: threadId ?? "active",
        threadId,
        spawnDir: null,
        monitorUpdatesEnabled: null,
        monitorUpdateIntervalSec: null,
        pushEnabled: parsedState,
        mode: "bridge",
        payloadContent: rawArgs,
        picker: null,
        priority: null
      });
    }

    case "/list":
      return createParsedSlashCommand({
        intent: "list",
        shouldForward: true,
        target: "all",
        threadId: null,
        spawnDir: null,
        monitorUpdatesEnabled: null,
        monitorUpdateIntervalSec: null,
        pushEnabled: null,
        mode: "bridge",
        payloadContent: "",
        picker: null,
        priority: null
      });

    case "/help":
      return createParsedSlashCommand({
        intent: "help",
        shouldForward: false,
        target: "none",
        threadId: null,
        spawnDir: null,
        monitorUpdatesEnabled: null,
        monitorUpdateIntervalSec: null,
        pushEnabled: null,
        mode: "bridge",
        payloadContent: "",
        picker: null,
        priority: null
      });

    case "/restart":
      return createParsedSlashCommand({
        intent: "service_restart",
        shouldForward: false,
        target: "none",
        threadId: null,
        spawnDir: null,
        monitorUpdatesEnabled: null,
        monitorUpdateIntervalSec: null,
        pushEnabled: null,
        mode: "bridge",
        payloadContent: "",
        picker: null,
        priority: null
      });

    case "/browse":
      return createParsedSlashCommand({
        intent: "browse",
        shouldForward: false,
        target: "none",
        threadId: null,
        spawnDir: null,
        monitorUpdatesEnabled: null,
        monitorUpdateIntervalSec: null,
        pushEnabled: null,
        mode: "bridge",
        payloadContent: "",
        picker: null,
        priority: null
      });

    default:
      throw new Error(`Unsupported command: ${command}. Use /help for usage.`);
  }
}

function normalizeCommandPrefix(content: string): string {
  if (!content) {
    return content;
  }

  const first = content[0];
  if (first === "/" || !ALT_SLASH_PREFIXES.has(first)) {
    return content;
  }

  return `/${content.slice(1)}`;
}
