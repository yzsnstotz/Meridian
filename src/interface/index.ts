import { spawn as spawnProcess, spawnSync as spawnSyncProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { InlineKeyboard, webhookCallback } from "grammy";
import type { Context } from "grammy";
import {
  AgentInstanceSchema,
  ProviderModelCatalogSchema,
  type AgentInstance,
  type AgentType,
  type HubMessage,
  type Intent,
  type ProviderModel
} from "../types";
import { config } from "../config";
import { createLogger } from "../logger";
import { normalizeApprovalAction } from "../shared/approval";
import { parseHubActionCallbackData } from "../shared/telegram-controls";
import { authMiddleware } from "./auth";
import { botRuntimes, syncBotCommands } from "./bot";
import { requestHubMessage, sendHubMessage } from "./ipc-sender";
import { formatTelegramActorId, formatTelegramChatId, parseTelegramMessage } from "./parser";
import { getHelpMessage, parseSlashCommand, type ParsedSlashCommand } from "./slash-handler";

const interfaceLog = createLogger("interface");
const SPAWN_TYPES: AgentType[] = ["claude", "codex", "gemini", "cursor"];
const CALLBACK_PREFIX = "pk";
const LIVE_INSTANCE_STATUSES = new Set<AgentInstance["status"]>(["idle", "running", "waiting"]);
const SPAWN_DIR_ROOT = config.AGENT_WORKDIR;
const SPAWN_DIR_MAX_BUTTONS = 24;
const BROWSE_ROOT = process.cwd();
const BROWSE_MAX_BUTTONS = 24;
const SPAWN_DIR_SESSION_TTL_MS = 15 * 60 * 1000;
const MODEL_PICKER_MAX_BUTTONS = 20;
const MODEL_PICKER_TTL_MS = 5 * 60 * 1000;

function buildTelegramReplyChannel(params: {
  chatId: string;
  botId: string;
  messageId?: string;
  chatName?: string | null;
  botName?: string | null;
}): { channel: "telegram"; chat_id: string; bot_id: string; message_id?: string; chat_name?: string; bot_name?: string } {
  return {
    channel: "telegram",
    chat_id: params.chatId,
    bot_id: params.botId,
    message_id: params.messageId,
    chat_name: params.chatName ?? undefined,
    bot_name: params.botName ?? undefined
  };
}

type TelegramBotInfoLike = {
  id: number;
  username?: string;
};

type TelegramBotLike = {
  api: {
    deleteWebhook: (options?: { drop_pending_updates?: boolean }) => Promise<unknown>;
    setWebhook: (url: string, options?: { secret_token?: string }) => Promise<unknown>;
  };
  botInfo?: TelegramBotInfoLike;
  init: () => Promise<void>;
  start: (options?: { onStart?: (botInfo: TelegramBotInfoLike) => void | Promise<void> }) => Promise<void>;
  stop: () => void;
};

export interface InterfaceBotRuntime {
  bot: TelegramBotLike;
  botId: string;
}

export interface InterfaceLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface WebhookServerLike {
  listen: (port: number, listeningListener?: () => void) => void;
  close: (callback?: (error?: Error) => void) => void;
}

type WebhookHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;

interface StartInterfaceOptions {
  runtimes?: InterfaceBotRuntime[];
  syncBotCommands?: () => Promise<void>;
  webhookUrl?: string;
  webhookPort?: number;
  webhookSecretToken?: string;
  logger?: InterfaceLogger;
  serverFactory?: (handler: http.RequestListener) => WebhookServerLike;
  webhookHandlerFactory?: (bot: TelegramBotLike, secretToken?: string) => WebhookHandler;
}

interface HubActionCallbackHandlerOptions {
  dispatchHubMessage?: (message: HubMessage) => Promise<void>;
}

interface SpawnDirectorySession {
  sessionId: string;
  botId: string;
  chatId: string;
  type: AgentType;
  mode: "bridge" | "pane_bridge";
  currentDir: string;
  entries: string[];
  createdAtMs: number;
  pickerMessageId: string | null;
  awaitingFolderName: boolean;
}

interface BrowseEntry {
  name: string;
  type: "directory" | "file";
}

interface BrowseSession {
  sessionId: string;
  botId: string;
  chatId: string;
  currentDir: string;
  entries: BrowseEntry[];
  createdAtMs: number;
  pickerMessageId: string | null;
}

interface ModelPickerSession {
  sessionId: string;
  botId: string;
  chatId: string;
  threadId: string;
  provider: AgentType;
  currentModelId: string | null;
  models: ProviderModel[];
  createdAtMs: number;
  pickerMessageId: string | null;
}

const spawnDirectorySessions = new Map<string, SpawnDirectorySession>();
const browseSessions = new Map<string, BrowseSession>();
const modelPickerSessions = new Map<string, ModelPickerSession>();
type SendMessageExtra = Parameters<Context["api"]["sendMessage"]>[2];

interface LiveInstanceCandidate {
  instance: AgentInstance;
  attachable: boolean;
  attachedSessions: string[];
}

function normalizeTerminalReplyInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const approval = normalizeApprovalAction(trimmed);
  if (approval) {
    return approval;
  }
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  if (/^(?:y|n|yes|no)$/i.test(trimmed)) {
    return trimmed;
  }
  if (/^\/model$/i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function isAgentType(value: string): value is AgentType {
  return SPAWN_TYPES.includes(value as AgentType);
}

function isBridgeMode(value: string): value is "bridge" | "pane_bridge" {
  return value === "bridge" || value === "pane_bridge";
}

function resolveThreadId(parsedCommand: ParsedSlashCommand, fallbackReplyTo: string | null): string {
  if (parsedCommand.threadId) {
    return parsedCommand.threadId;
  }
  if (fallbackReplyTo) {
    return fallbackReplyTo;
  }
  if (parsedCommand.intent === "spawn") {
    return "pending";
  }
  if (parsedCommand.intent === "list") {
    return "global";
  }
  return "unbound";
}

export function toHubMessage(
  parsedCommand: ParsedSlashCommand,
  payload: Awaited<ReturnType<typeof parseTelegramMessage>>
): HubMessage {
  if (!payload) {
    throw new Error("Cannot build HubMessage from empty payload");
  }

  if (parsedCommand.intent === "help" || parsedCommand.intent === "service_restart" || parsedCommand.intent === "browse") {
    throw new Error(`${parsedCommand.intent} command should not be forwarded`);
  }

  const threadId = resolveThreadId(parsedCommand, payload.event.reply_to);
  const target =
    parsedCommand.target === "active" ? (payload.event.reply_to ?? "active") : parsedCommand.target;
  const content =
    parsedCommand.intent === "set_auto_approve"
      ? parsedCommand.autoApproveValue === null
        ? (() => {
            throw new Error("set_auto_approve command requires autoApproveValue");
          })()
        : String(parsedCommand.autoApproveValue)
      : parsedCommand.payloadContent || payload.event.content;

  return {
    trace_id: randomUUID(),
    thread_id: threadId,
    actor_id: payload.actorId,
    idempotency_key: payload.event.raw_message_id,
    priority: parsedCommand.priority ?? undefined,
    intent: parsedCommand.intent,
    target,
    payload: {
      content,
      attachments: payload.event.attachments,
      raw_message_id: payload.event.raw_message_id,
      reply_to: payload.event.reply_to,
      spawn_dir: parsedCommand.spawnDir ?? undefined,
      monitor_updates_enabled: parsedCommand.monitorUpdatesEnabled ?? undefined,
      monitor_updates_interval_sec: parsedCommand.monitorUpdateIntervalSec ?? undefined,
      push_enabled: parsedCommand.pushEnabled ?? undefined
    },
    mode: parsedCommand.mode,
    suppress_reply: false,
    reply_channel: buildTelegramReplyChannel({
      chatId: payload.chatId,
      botId: payload.botId,
      messageId: payload.event.raw_message_id,
      chatName: payload.chatName,
      botName: payload.botName
    })
  };
}

function buildActionHubMessage(params: {
  actorId: string;
  botId: string;
  chatId: string;
  messageId?: string;
  chatName?: string | null;
  botName?: string | null;
  intent: Intent;
  threadId: string;
  target: string;
  content?: string;
  mode?: "bridge" | "pane_bridge";
  spawnDir?: string;
  suppressReply?: boolean;
}): HubMessage {
  return {
    trace_id: randomUUID(),
    thread_id: params.threadId,
    actor_id: params.actorId,
    intent: params.intent,
    target: params.target,
    payload: {
      content: params.content ?? "",
      attachments: [],
      raw_message_id: params.messageId,
      reply_to: null,
      spawn_dir: params.spawnDir
    },
    mode: params.mode ?? "bridge",
    suppress_reply: params.suppressReply ?? false,
    reply_channel: buildTelegramReplyChannel({
      chatId: params.chatId,
      botId: params.botId,
      messageId: params.messageId,
      chatName: params.chatName,
      botName: params.botName
    })
  };
}

function resolveChatNameFromContext(ctx: Context): string | null {
  const chat = ctx.chat as { title?: unknown; username?: unknown; first_name?: unknown; last_name?: unknown } | undefined;
  if (!chat) {
    return null;
  }
  const title = typeof chat.title === "string" ? chat.title.trim() : "";
  if (title) {
    return title;
  }
  const fullName = [chat.first_name, chat.last_name]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");
  if (fullName) {
    return fullName;
  }
  const username = typeof chat.username === "string" ? chat.username.trim() : "";
  if (username) {
    return `@${username}`;
  }
  return null;
}

function resolveBotNameFromContext(ctx: Context): string | null {
  const username = typeof ctx.me?.username === "string" ? ctx.me.username.trim() : "";
  if (username) {
    return `@${username}`;
  }
  return null;
}

function buildSpawnProviderKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keyboard.text("Claude", `${CALLBACK_PREFIX}:spawn_type:claude`);
  keyboard.text("Codex", `${CALLBACK_PREFIX}:spawn_type:codex`);
  keyboard.row();
  keyboard.text("Gemini", `${CALLBACK_PREFIX}:spawn_type:gemini`);
  keyboard.text("Cursor", `${CALLBACK_PREFIX}:spawn_type:cursor`);
  return keyboard;
}

function buildSpawnModeKeyboard(type: AgentType): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keyboard.text("bridge", `${CALLBACK_PREFIX}:spawn_mode:${type}:bridge`);
  keyboard.text("pane_bridge", `${CALLBACK_PREFIX}:spawn_mode:${type}:pane_bridge`);
  return keyboard;
}

function sanitizeCallbackToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
}

function normalizeSpawnDirectory(candidate: string): string | null {
  const resolvedRoot = path.resolve(SPAWN_DIR_ROOT);
  const resolvedCandidate = path.resolve(candidate);
  if (
    resolvedCandidate !== resolvedRoot &&
    !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    return null;
  }
  return resolvedCandidate;
}

function listDirectoriesUnder(currentDir: string): string[] {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, SPAWN_DIR_MAX_BUTTONS);
}

function normalizeBrowsePath(candidate: string): string | null {
  const resolvedRoot = path.resolve(BROWSE_ROOT);
  const resolvedCandidate = path.resolve(candidate);
  if (
    resolvedCandidate !== resolvedRoot &&
    !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    return null;
  }
  return resolvedCandidate;
}

function listBrowseEntriesUnder(currentDir: string): BrowseEntry[] {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry): BrowseEntry => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file"
    }))
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, BROWSE_MAX_BUTTONS);
}

function pruneSpawnDirectorySessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of spawnDirectorySessions.entries()) {
    if (now - session.createdAtMs > SPAWN_DIR_SESSION_TTL_MS) {
      spawnDirectorySessions.delete(sessionId);
    }
  }
}

function pruneBrowseSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of browseSessions.entries()) {
    if (now - session.createdAtMs > SPAWN_DIR_SESSION_TTL_MS) {
      browseSessions.delete(sessionId);
    }
  }
}

export function buildSpawnDirectoryKeyboard(session: SpawnDirectorySession): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keyboard.text("Use This Folder", `${CALLBACK_PREFIX}:spawn_dir:${session.sessionId}:select`).row();
  keyboard.text("Create Folder", `${CALLBACK_PREFIX}:spawn_dir:${session.sessionId}:create`).row();
  keyboard.text("Up", `${CALLBACK_PREFIX}:spawn_dir:${session.sessionId}:up`).row();

  for (let index = 0; index < session.entries.length; index += 1) {
    const entryName = session.entries[index];
    keyboard
      .text(entryName, `${CALLBACK_PREFIX}:spawn_dir:${session.sessionId}:open:${index}`)
      .row();
  }

  keyboard.text("Cancel", `${CALLBACK_PREFIX}:spawn_dir:${session.sessionId}:cancel`);
  return keyboard;
}

function buildSpawnDirectoryPrompt(session: SpawnDirectorySession): string {
  return [
    `Provider: ${session.type}`,
    `Mode: ${session.mode}`,
    `Root: ${SPAWN_DIR_ROOT}`,
    `Current: ${session.currentDir}`,
    session.awaitingFolderName
      ? "Create folder mode: send the new folder name in chat, or send 'cancel'."
      : "",
    session.entries.length === 0 ? "No child folders. Choose Use This Folder or Up." : "Choose a folder:"
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function buildBrowseKeyboard(session: BrowseSession): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keyboard.text("Use This Folder", `${CALLBACK_PREFIX}:browse_dir:${session.sessionId}:select`).row();
  if (path.resolve(session.currentDir) !== path.resolve(BROWSE_ROOT)) {
    keyboard.text("Up", `${CALLBACK_PREFIX}:browse_dir:${session.sessionId}:up`).row();
  }

  for (let index = 0; index < session.entries.length; index += 1) {
    const entry = session.entries[index];
    const label = `${entry.type === "directory" ? "[D]" : "[F]"} ${entry.name}`;
    const action = entry.type === "directory" ? "open" : "pick";
    keyboard.text(label, `${CALLBACK_PREFIX}:browse_dir:${session.sessionId}:${action}:${index}`).row();
  }

  keyboard.text("Cancel", `${CALLBACK_PREFIX}:browse_dir:${session.sessionId}:cancel`);
  return keyboard;
}

function buildBrowsePrompt(session: BrowseSession): string {
  return [
    `Browse Root: ${BROWSE_ROOT}`,
    `Current: ${session.currentDir}`,
    session.entries.length === 0
      ? "No files/folders here. Choose Use This Folder or Up."
      : "Choose a folder to enter, or choose a file to send its exact path."
  ].join("\n");
}

function beginSpawnDirectorySession(
  botId: string,
  chatId: string,
  type: AgentType,
  mode: "bridge" | "pane_bridge"
): SpawnDirectorySession {
  const initialDir = normalizeSpawnDirectory(SPAWN_DIR_ROOT);
  if (!initialDir || !fs.existsSync(initialDir) || !fs.statSync(initialDir).isDirectory()) {
    throw new Error(`Spawn root directory is unavailable: ${SPAWN_DIR_ROOT}`);
  }

  const sessionId = sanitizeCallbackToken(randomUUID().slice(0, 8));
  const session: SpawnDirectorySession = {
    sessionId,
    botId,
    chatId,
    type,
    mode,
    currentDir: initialDir,
    entries: listDirectoriesUnder(initialDir),
    createdAtMs: Date.now(),
    pickerMessageId: null,
    awaitingFolderName: false
  };
  spawnDirectorySessions.set(sessionId, session);
  return session;
}

function beginBrowseSession(botId: string, chatId: string): BrowseSession {
  const initialDir = normalizeBrowsePath(BROWSE_ROOT);
  if (!initialDir || !fs.existsSync(initialDir) || !fs.statSync(initialDir).isDirectory()) {
    throw new Error(`Browse root directory is unavailable: ${BROWSE_ROOT}`);
  }

  const sessionId = sanitizeCallbackToken(randomUUID().slice(0, 8));
  const session: BrowseSession = {
    sessionId,
    botId,
    chatId,
    currentDir: initialDir,
    entries: listBrowseEntriesUnder(initialDir),
    createdAtMs: Date.now(),
    pickerMessageId: null
  };
  browseSessions.set(sessionId, session);
  return session;
}

function refreshSpawnDirectorySession(session: SpawnDirectorySession): void {
  const normalized = normalizeSpawnDirectory(session.currentDir);
  if (!normalized || !fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) {
    throw new Error(`Directory is unavailable: ${session.currentDir}`);
  }
  session.currentDir = normalized;
  session.entries = listDirectoriesUnder(normalized);
  session.createdAtMs = Date.now();
}

function refreshBrowseSession(session: BrowseSession): void {
  const normalized = normalizeBrowsePath(session.currentDir);
  if (!normalized || !fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) {
    throw new Error(`Directory is unavailable: ${session.currentDir}`);
  }
  session.currentDir = normalized;
  session.entries = listBrowseEntriesUnder(normalized);
  session.createdAtMs = Date.now();
}

function findPendingFolderCreateSession(botId: string, chatId: string): SpawnDirectorySession | null {
  pruneSpawnDirectorySessions();

  let latest: SpawnDirectorySession | null = null;
  for (const session of spawnDirectorySessions.values()) {
    if (session.botId !== botId || session.chatId !== chatId || !session.awaitingFolderName) {
      continue;
    }
    if (!latest || session.createdAtMs > latest.createdAtMs) {
      latest = session;
    }
  }
  return latest;
}

function validateNewDirectoryName(rawName: string): string {
  const name = rawName.trim();
  if (name.length === 0) {
    throw new Error("Folder name cannot be empty.");
  }
  if (name === "." || name === "..") {
    throw new Error("Folder name cannot be . or ..");
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new Error("Folder name cannot include path separators.");
  }
  return name;
}

async function refreshSpawnDirectoryPickerMessage(ctx: Context, session: SpawnDirectorySession): Promise<void> {
  if (!session.pickerMessageId) {
    return;
  }

  const messageId = Number(session.pickerMessageId);
  if (!Number.isInteger(messageId)) {
    return;
  }

  try {
    await ctx.api.editMessageText(session.chatId, messageId, buildSpawnDirectoryPrompt(session), {
      reply_markup: buildSpawnDirectoryKeyboard(session)
    });
  } catch (error) {
    interfaceLog.warn(
      { err: error instanceof Error ? error.message : String(error), picker_message_id: session.pickerMessageId },
      "Failed to refresh spawn directory picker message"
    );
  }
}

async function maybeHandleSpawnDirectoryCreateInput(
  ctx: Context,
  botId: string,
  chatId: string,
  rawInput: string,
  reply: (text: string) => Promise<unknown>
): Promise<boolean> {
  const session = findPendingFolderCreateSession(botId, chatId);
  if (!session) {
    return false;
  }

  const input = rawInput.trim();
  if (!input) {
    await reply("Folder name is empty. Send a folder name, or send 'cancel'.");
    return true;
  }
  if (input.startsWith("/") && input !== "/cancel") {
    return false;
  }

  if (input === "/cancel" || input.toLowerCase() === "cancel") {
    session.awaitingFolderName = false;
    session.createdAtMs = Date.now();
    await refreshSpawnDirectoryPickerMessage(ctx, session);
    await reply("Folder creation cancelled.");
    return true;
  }

  const name = validateNewDirectoryName(input);
  const candidateDir = normalizeSpawnDirectory(path.join(session.currentDir, name));
  if (!candidateDir) {
    throw new Error("Folder path is outside the allowed spawn root.");
  }

  if (fs.existsSync(candidateDir)) {
    const stats = fs.statSync(candidateDir);
    if (!stats.isDirectory()) {
      throw new Error("A file with that name already exists.");
    }
  } else {
    fs.mkdirSync(candidateDir);
  }

  session.currentDir = candidateDir;
  session.awaitingFolderName = false;
  refreshSpawnDirectorySession(session);
  await refreshSpawnDirectoryPickerMessage(ctx, session);
  await reply(`Using folder: ${session.currentDir}`);
  return true;
}

function getSpawnDirectorySession(sessionId: string, botId: string, chatId: string): SpawnDirectorySession {
  pruneSpawnDirectorySessions();
  const session = spawnDirectorySessions.get(sessionId);
  if (!session) {
    throw new Error("Spawn directory picker expired. Run /spawn again.");
  }
  if (session.botId !== botId || session.chatId !== chatId) {
    throw new Error("Spawn directory picker does not belong to this chat.");
  }
  return session;
}

function getBrowseSession(sessionId: string, botId: string, chatId: string): BrowseSession {
  pruneBrowseSessions();
  const session = browseSessions.get(sessionId);
  if (!session) {
    throw new Error("Browse picker expired. Run /browse again.");
  }
  if (session.botId !== botId || session.chatId !== chatId) {
    throw new Error("Browse picker does not belong to this chat.");
  }
  return session;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function launchRestartViaTmux(projectRoot: string, scriptPath: string, restartLogPath: string): boolean {
  const sessionName = `meridian_restart_${Date.now()}`;
  const tmuxCommand = `/bin/bash ${shellEscape(scriptPath)} > ${shellEscape(restartLogPath)} 2>&1`;
  const launched = spawnSyncProcess("tmux", ["new-session", "-d", "-s", sessionName, tmuxCommand], {
    cwd: projectRoot,
    stdio: "ignore"
  });
  if (launched.error || launched.status !== 0) {
    interfaceLog.warn(
      {
        session: sessionName,
        status: launched.status,
        signal: launched.signal,
        error: launched.error?.message
      },
      "Failed to launch restart in tmux"
    );
    return false;
  }

  interfaceLog.info({ session: sessionName, log_path: restartLogPath }, "Restart launched via tmux");
  return true;
}

function launchRestartDetached(projectRoot: string, scriptPath: string, restartLogPath: string): void {
  const command = `nohup /bin/bash ${shellEscape(scriptPath)} > ${shellEscape(restartLogPath)} 2>&1 < /dev/null &`;
  const launcher = spawnProcess("/bin/zsh", ["-lc", command], {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore"
  });
  launcher.unref();
}

function buildRestartKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keyboard.text("Restart Service Keep Agents", `${CALLBACK_PREFIX}:restart_service:keep_agents`).row();
  keyboard.text("Rebuild & Restart Everything", `${CALLBACK_PREFIX}:restart_service:full_rebuild`);
  return keyboard;
}

async function handleRestartCommand(ctx: Context): Promise<void> {
  await ctx.reply("Choose Meridian service action:", { reply_markup: buildRestartKeyboard() });
}

function buildThreadPickerKeyboard(
  instances: AgentInstance[],
  action: "attach" | "kill" | "model_thread" | "restart_thread"
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const instance of instances) {
    const label = `${instance.thread_id} (${instance.agent_type}, ${instance.mode})`;
    keyboard.text(label, `${CALLBACK_PREFIX}:${action}:${instance.thread_id}`).row();
  }
  return keyboard;
}

function beginModelPickerSession(
  botId: string,
  chatId: string,
  threadId: string,
  provider: AgentType,
  currentModelId: string | null,
  models: ProviderModel[]
): ModelPickerSession {
  const sessionId = sanitizeCallbackToken(randomUUID());
  const orderedModels = currentModelId
    ? [
        ...models.filter((model) => model.id === currentModelId),
        ...models.filter((model) => model.id !== currentModelId)
      ]
    : models;
  const session: ModelPickerSession = {
    sessionId,
    botId,
    chatId,
    threadId,
    provider,
    currentModelId,
    models: orderedModels.slice(0, MODEL_PICKER_MAX_BUTTONS),
    createdAtMs: Date.now(),
    pickerMessageId: null
  };
  modelPickerSessions.set(sessionId, session);
  return session;
}

function getModelPickerSession(sessionId: string, botId: string, chatId: string): ModelPickerSession {
  const session = modelPickerSessions.get(sessionId);
  if (!session) {
    throw new Error("Model picker expired. Run /model again.");
  }
  if (Date.now() - session.createdAtMs > MODEL_PICKER_TTL_MS) {
    modelPickerSessions.delete(sessionId);
    throw new Error("Model picker expired. Run /model again.");
  }
  if (session.botId !== botId || session.chatId !== chatId) {
    throw new Error("Model picker does not belong to this chat.");
  }
  return session;
}

function buildModelPickerPrompt(session: ModelPickerSession): string {
  const currentModel = session.currentModelId ?? "provider default";
  return [
    `Thread: ${session.threadId}`,
    `Provider: ${session.provider}`,
    `Current model: ${currentModel}`,
    "Choose model:"
  ].join("\n");
}

function buildModelPickerKeyboard(session: ModelPickerSession): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let index = 0; index < session.models.length; index += 1) {
    const model = session.models[index];
    if (!model) {
      continue;
    }
    const prefix = model.id === session.currentModelId ? "Current: " : "";
    keyboard.text(`${prefix}${model.label}`, `${CALLBACK_PREFIX}:model_pick:${session.sessionId}:${index}`).row();
  }
  keyboard.text("Refresh", `${CALLBACK_PREFIX}:model_refresh:${session.threadId}`).text(
    "Cancel",
    `${CALLBACK_PREFIX}:model_cancel:${session.sessionId}`
  );
  return keyboard;
}

async function requestProviderModels(
  botId: string,
  chatId: string,
  actorId: string,
  threadId: string,
  messageId?: string
): Promise<ModelPickerSession> {
  const response = await requestHubMessage(
    buildActionHubMessage({
      actorId,
      botId,
      chatId,
      messageId,
      intent: "list_models",
      threadId,
      target: threadId,
      suppressReply: true
    })
  );

  if (response.status !== "success") {
    throw new Error(response.content);
  }

  const parsed = ProviderModelCatalogSchema.parse(JSON.parse(response.content));
  return beginModelPickerSession(botId, chatId, parsed.thread_id, parsed.provider, parsed.current_model_id, parsed.models);
}

async function requestLiveInstances(
  botId: string,
  chatId: string,
  actorId: string,
  messageId?: string
): Promise<LiveInstanceCandidate[]> {
  const response = await requestHubMessage(
    buildActionHubMessage({
      actorId,
      botId,
      chatId,
      messageId,
      intent: "list",
      threadId: "global",
      target: "all",
      suppressReply: true
    })
  );

  if (response.status !== "success") {
    throw new Error(response.content);
  }
  if (response.content.includes("No active agent instances.")) {
    return [];
  }

  const parsed = JSON.parse(response.content) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid /list payload: expected an array");
  }

  const candidates = parsed.map((raw): LiveInstanceCandidate => {
    const instance = AgentInstanceSchema.parse(raw);
    const attachable =
      typeof raw === "object" &&
      raw !== null &&
      "attachable" in raw &&
      typeof (raw as { attachable?: unknown }).attachable === "boolean"
        ? ((raw as { attachable: boolean }).attachable)
        : true;
    const attachedSessions =
      typeof raw === "object" &&
      raw !== null &&
      "attached_sessions" in raw &&
      Array.isArray((raw as { attached_sessions?: unknown }).attached_sessions)
        ? (raw as { attached_sessions: string[] }).attached_sessions.filter((entry) => typeof entry === "string")
        : [];
    return { instance, attachable, attachedSessions };
  });
  return candidates.filter(({ instance }) => LIVE_INSTANCE_STATUSES.has(instance.status));
}

async function presentPickerFlow(
  parsedCommand: ParsedSlashCommand,
  payload: NonNullable<Awaited<ReturnType<typeof parseTelegramMessage>>>,
  reply: (text: string, extra?: SendMessageExtra) => Promise<unknown>
): Promise<void> {
  const messageId = payload.event.raw_message_id;
  const chatId = payload.chatId;

  if (parsedCommand.picker === "spawn") {
    await reply("Choose provider:", { reply_markup: buildSpawnProviderKeyboard() });
    return;
  }

  if (parsedCommand.picker === "attach" || parsedCommand.picker === "kill" || parsedCommand.picker === "switch_model") {
    if (parsedCommand.picker === "switch_model" && parsedCommand.threadId) {
      const session = await requestProviderModels(payload.botId, chatId, payload.actorId, parsedCommand.threadId, messageId);
      await reply(buildModelPickerPrompt(session), {
        reply_markup: buildModelPickerKeyboard(session)
      });
      return;
    }

    const candidates = await requestLiveInstances(payload.botId, chatId, payload.actorId, messageId);
    if (candidates.length === 0) {
      await reply("No active live threads found. Use /spawn first.");
      return;
    }

    if (parsedCommand.picker === "attach") {
      const attachableInstances = candidates.filter((candidate) => candidate.attachable).map((candidate) => candidate.instance);
      if (attachableInstances.length === 0) {
        await reply("No attachable live threads found for this bot.");
        return;
      }
      await reply("Choose thread to attach:", { reply_markup: buildThreadPickerKeyboard(attachableInstances, "attach") });
      return;
    }
    if (parsedCommand.picker === "kill") {
      await reply("Choose thread to kill:", { reply_markup: buildThreadPickerKeyboard(candidates.map((candidate) => candidate.instance), "kill") });
      return;
    }

    const attachedSessionId = `${payload.botId}:${chatId}`;
    const activeCandidate = candidates.find((candidate) => candidate.attachedSessions.includes(attachedSessionId));
    if (activeCandidate) {
      const session = await requestProviderModels(
        payload.botId,
        chatId,
        payload.actorId,
        activeCandidate.instance.thread_id,
        messageId
      );
      await reply(buildModelPickerPrompt(session), {
        reply_markup: buildModelPickerKeyboard(session)
      });
      return;
    }

    await reply("Choose thread to switch model:", {
      reply_markup: buildThreadPickerKeyboard(candidates.map((candidate) => candidate.instance), "model_thread")
    });
    return;
  }
}

async function handlePickerCallbackData(data: string, ctx: Context): Promise<boolean> {
  if (!data.startsWith(`${CALLBACK_PREFIX}:`)) {
    return false;
  }

  const parts = data.split(":");
  const rawChatId = ctx.chat?.id ? String(ctx.chat.id) : null;
  const botId = String(ctx.me.id);
  const rawActorId = ctx.from?.id;
  const callbackMessageId =
    "callbackQuery" in ctx && ctx.callbackQuery?.message && "message_id" in ctx.callbackQuery.message
      ? String(ctx.callbackQuery.message.message_id)
      : undefined;
  if (!rawChatId) {
    await ctx.answerCallbackQuery({ text: "Chat id missing" });
    return true;
  }
  if (!rawActorId) {
    await ctx.answerCallbackQuery({ text: "Sender id missing" });
    return true;
  }
  const chatId = formatTelegramChatId(rawChatId);
  const actorId = formatTelegramActorId(rawActorId);
  const chatName = resolveChatNameFromContext(ctx);
  const botName = resolveBotNameFromContext(ctx);

  const action = parts[1];
  if (!action) {
    await ctx.answerCallbackQuery({ text: "Invalid action" });
    return true;
  }

  if (action === "spawn_type" && parts[2]) {
    const type = parts[2];
    if (!isAgentType(type)) {
      await ctx.answerCallbackQuery({ text: "Invalid provider" });
      return true;
    }
    await ctx.editMessageText(`Provider: ${type}\nChoose mode:`, { reply_markup: buildSpawnModeKeyboard(type) });
    await ctx.answerCallbackQuery();
    return true;
  }

  if (action === "restart_menu" && parts[2] === "thread") {
    const candidates = await requestLiveInstances(botId, chatId, actorId, callbackMessageId);
    if (candidates.length === 0) {
      await ctx.editMessageText("No active live threads found. Use /spawn first.");
      await ctx.answerCallbackQuery();
      return true;
    }
    await ctx.editMessageText("Choose thread to restart:", {
      reply_markup: buildThreadPickerKeyboard(candidates.map((candidate) => candidate.instance), "restart_thread")
    });
    await ctx.answerCallbackQuery();
    return true;
  }

  if (action === "restart_service" && parts[2]) {
    const projectRoot = process.cwd();
    const scriptName = parts[2] === "keep_agents" ? "user_scripts/restart_keep_agents.sh" : "rebuild-restart.sh";
    const scriptPath = path.resolve(projectRoot, scriptName);
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Restart script not found: ${scriptPath}`);
    }

    const logSuffix = parts[2] === "keep_agents" ? "keep-agents" : "full";
    const restartLogPath = path.join("/tmp", `meridian-restart-${logSuffix}-${Date.now()}.log`);
    const label =
      parts[2] === "keep_agents"
        ? "Restarting Meridian service and preserving live agents"
        : "Rebuilding project and restarting everything";

    await ctx.editMessageText(`${label}.\nLog: ${restartLogPath}`);
    if (!launchRestartViaTmux(projectRoot, scriptPath, restartLogPath)) {
      launchRestartDetached(projectRoot, scriptPath, restartLogPath);
    }
    await ctx.answerCallbackQuery();
    return true;
  }

  if (action === "spawn_mode" && parts[2] && parts[3]) {
    const type = parts[2];
    const mode = parts[3];
    if (!isAgentType(type) || !isBridgeMode(mode)) {
      await ctx.answerCallbackQuery({ text: "Invalid spawn option" });
      return true;
    }
    const session = beginSpawnDirectorySession(botId, chatId, type, mode);
    session.pickerMessageId = callbackMessageId ?? null;
    await ctx.editMessageText(buildSpawnDirectoryPrompt(session), {
      reply_markup: buildSpawnDirectoryKeyboard(session)
    });
    await ctx.answerCallbackQuery();
    return true;
  }

  if (action === "spawn_dir" && parts[2] && parts[3]) {
    const sessionId = parts[2];
    const operation = parts[3];
    const session = getSpawnDirectorySession(sessionId, botId, chatId);
    session.pickerMessageId = callbackMessageId ?? session.pickerMessageId;

    if (operation === "cancel") {
      spawnDirectorySessions.delete(sessionId);
      await ctx.editMessageText("Spawn cancelled.");
      await ctx.answerCallbackQuery();
      return true;
    }

    if (operation === "select") {
      session.awaitingFolderName = false;
      await sendHubMessage(
        buildActionHubMessage({
          actorId,
          botId,
          chatId,
          chatName,
          botName,
          messageId: callbackMessageId,
          intent: "spawn",
          threadId: "pending",
          target: session.type,
          mode: session.mode,
          spawnDir: session.currentDir
        })
      );
      spawnDirectorySessions.delete(sessionId);
      await ctx.editMessageText(`Spawning ${session.type} (${session.mode}) in ${session.currentDir}...`);
      await ctx.answerCallbackQuery();
      return true;
    }

    if (operation === "up") {
      session.awaitingFolderName = false;
      const parent = normalizeSpawnDirectory(path.join(session.currentDir, ".."));
      if (!parent) {
        await ctx.answerCallbackQuery({ text: "Already at root" });
        return true;
      }
      session.currentDir = parent;
      refreshSpawnDirectorySession(session);
      await ctx.editMessageText(buildSpawnDirectoryPrompt(session), {
        reply_markup: buildSpawnDirectoryKeyboard(session)
      });
      await ctx.answerCallbackQuery();
      return true;
    }

    if (operation === "create") {
      session.awaitingFolderName = true;
      session.createdAtMs = Date.now();
      await ctx.editMessageText(buildSpawnDirectoryPrompt(session), {
        reply_markup: buildSpawnDirectoryKeyboard(session)
      });
      await ctx.answerCallbackQuery({ text: "Send folder name in chat" });
      return true;
    }

    if (operation === "open" && parts[4]) {
      session.awaitingFolderName = false;
      const index = Number(parts[4]);
      if (!Number.isInteger(index) || index < 0 || index >= session.entries.length) {
        await ctx.answerCallbackQuery({ text: "Invalid folder option" });
        return true;
      }

      const selected = session.entries[index];
      const nextDir = normalizeSpawnDirectory(path.join(session.currentDir, selected));
      if (!nextDir || !fs.existsSync(nextDir) || !fs.statSync(nextDir).isDirectory()) {
        await ctx.answerCallbackQuery({ text: "Folder is no longer available" });
        return true;
      }

      session.currentDir = nextDir;
      refreshSpawnDirectorySession(session);
      await ctx.editMessageText(buildSpawnDirectoryPrompt(session), {
        reply_markup: buildSpawnDirectoryKeyboard(session)
      });
      await ctx.answerCallbackQuery();
      return true;
    }

    await ctx.answerCallbackQuery({ text: "Unsupported directory action" });
    return true;
  }

  if (action === "browse_dir" && parts[2] && parts[3]) {
    const sessionId = parts[2];
    const operation = parts[3];
    const session = getBrowseSession(sessionId, botId, chatId);
    session.pickerMessageId = callbackMessageId ?? session.pickerMessageId;

    if (operation === "cancel") {
      browseSessions.delete(sessionId);
      await ctx.editMessageText("Browse cancelled.");
      await ctx.answerCallbackQuery();
      return true;
    }

    if (operation === "select") {
      browseSessions.delete(sessionId);
      await ctx.editMessageText(`Selected folder path:\n${session.currentDir}`);
      await ctx.answerCallbackQuery({ text: "Path sent" });
      return true;
    }

    if (operation === "up") {
      const parent = normalizeBrowsePath(path.join(session.currentDir, ".."));
      if (!parent) {
        await ctx.answerCallbackQuery({ text: "Already at browse root" });
        return true;
      }
      session.currentDir = parent;
      refreshBrowseSession(session);
      await ctx.editMessageText(buildBrowsePrompt(session), {
        reply_markup: buildBrowseKeyboard(session)
      });
      await ctx.answerCallbackQuery();
      return true;
    }

    if ((operation === "open" || operation === "pick") && parts[4]) {
      const index = Number(parts[4]);
      if (!Number.isInteger(index) || index < 0 || index >= session.entries.length) {
        await ctx.answerCallbackQuery({ text: "Invalid browse option" });
        return true;
      }

      const selected = session.entries[index];
      const selectedPath = normalizeBrowsePath(path.join(session.currentDir, selected.name));
      if (!selectedPath || !fs.existsSync(selectedPath)) {
        await ctx.answerCallbackQuery({ text: "Path is no longer available" });
        return true;
      }

      const selectedStats = fs.statSync(selectedPath);
      if (operation === "open") {
        if (selected.type !== "directory" || !selectedStats.isDirectory()) {
          await ctx.answerCallbackQuery({ text: "Not a folder" });
          return true;
        }
        session.currentDir = selectedPath;
        refreshBrowseSession(session);
        await ctx.editMessageText(buildBrowsePrompt(session), {
          reply_markup: buildBrowseKeyboard(session)
        });
        await ctx.answerCallbackQuery();
        return true;
      }

      if (selected.type !== "file" || !selectedStats.isFile()) {
        await ctx.answerCallbackQuery({ text: "Not a file" });
        return true;
      }
      browseSessions.delete(sessionId);
      await ctx.editMessageText(`Selected file path:\n${selectedPath}`);
      await ctx.answerCallbackQuery({ text: "Path sent" });
      return true;
    }

    await ctx.answerCallbackQuery({ text: "Unsupported browse action" });
    return true;
  }

  if ((action === "attach" || action === "kill") && parts[2]) {
    const threadId = parts[2];
    await sendHubMessage(
      buildActionHubMessage({
        actorId,
        botId,
        chatId,
        chatName,
        botName,
        messageId: callbackMessageId,
        intent: action,
        threadId,
        target: threadId
      })
    );
    await ctx.editMessageText(`${action === "attach" ? "Attaching to" : "Killing"} ${threadId}...`);
    await ctx.answerCallbackQuery();
    return true;
  }

  if (action === "restart_thread" && parts[2]) {
    const threadId = parts[2];
    await sendHubMessage(
      buildActionHubMessage({
        actorId,
        botId,
        chatId,
        chatName,
        botName,
        messageId: callbackMessageId,
        intent: "restart",
        threadId,
        target: threadId
      })
    );
    await ctx.editMessageText(`Restarting ${threadId}...`);
    await ctx.answerCallbackQuery();
    return true;
  }

  if (action === "model_thread" && parts[2]) {
    const threadId = parts[2];
    const session = await requestProviderModels(botId, chatId, actorId, threadId, callbackMessageId);
    session.pickerMessageId = callbackMessageId ?? null;
    await ctx.editMessageText(buildModelPickerPrompt(session), {
      reply_markup: buildModelPickerKeyboard(session)
    });
    await ctx.answerCallbackQuery();
    return true;
  }

  if (action === "model_refresh" && parts[2]) {
    const threadId = parts[2];
    const session = await requestProviderModels(botId, chatId, actorId, threadId, callbackMessageId);
    session.pickerMessageId = callbackMessageId ?? null;
    await ctx.editMessageText(buildModelPickerPrompt(session), {
      reply_markup: buildModelPickerKeyboard(session)
    });
    await ctx.answerCallbackQuery({ text: "Models refreshed" });
    return true;
  }

  if (action === "model_cancel" && parts[2]) {
    modelPickerSessions.delete(parts[2]);
    await ctx.editMessageText("Model switch cancelled.");
    await ctx.answerCallbackQuery();
    return true;
  }

  if (action === "model_pick" && parts[2] && parts[3]) {
    const session = getModelPickerSession(parts[2], botId, chatId);
    session.pickerMessageId = callbackMessageId ?? session.pickerMessageId;
    const index = Number(parts[3]);
    if (!Number.isInteger(index) || index < 0 || index >= session.models.length) {
      await ctx.answerCallbackQuery({ text: "Invalid model option" });
      return true;
    }
    const selectedModel = session.models[index];
    if (!selectedModel) {
      await ctx.answerCallbackQuery({ text: "Invalid model option" });
      return true;
    }
    await sendHubMessage(
      buildActionHubMessage({
        actorId,
        botId,
        chatId,
        chatName,
        botName,
        messageId: callbackMessageId,
        intent: "switch_model",
        threadId: session.threadId,
        target: session.threadId,
        content: selectedModel.id
      })
    );
    modelPickerSessions.delete(session.sessionId);
    await ctx.editMessageText(
      `Switching ${session.threadId} to ${selectedModel.label} (${selectedModel.id})...`
    );
    await ctx.answerCallbackQuery();
    return true;
  }

  await ctx.answerCallbackQuery({ text: "Unsupported picker action" });
  return true;
}

export async function handleHubActionCallbackData(
  data: string,
  ctx: Context,
  options: HubActionCallbackHandlerOptions = {}
): Promise<boolean> {
  const parsed = parseHubActionCallbackData(data);
  if (!parsed) {
    return false;
  }

  const rawChatId = ctx.chat?.id ? String(ctx.chat.id) : null;
  const botId = String(ctx.me.id);
  const rawActorId = ctx.from?.id;
  const callbackMessageId =
    "callbackQuery" in ctx && ctx.callbackQuery?.message && "message_id" in ctx.callbackQuery.message
      ? String(ctx.callbackQuery.message.message_id)
      : undefined;
  if (!rawChatId) {
    await ctx.answerCallbackQuery({ text: "Chat id missing" });
    return true;
  }
  if (!rawActorId) {
    await ctx.answerCallbackQuery({ text: "Sender id missing" });
    return true;
  }

  const dispatchHubMessage = options.dispatchHubMessage ?? sendHubMessage;
  const chatId = formatTelegramChatId(rawChatId);
  const actorId = formatTelegramActorId(rawActorId);
  const chatName = resolveChatNameFromContext(ctx);
  const botName = resolveBotNameFromContext(ctx);

  await dispatchHubMessage(
    buildActionHubMessage({
      actorId,
      botId,
      chatId,
      chatName,
      botName,
      messageId: callbackMessageId,
      intent: parsed.intent,
      threadId: parsed.threadId,
      target: parsed.threadId
    })
  );
  await ctx.answerCallbackQuery({
    text: `${parsed.intent === "reboot" ? "Rebooting" : "Killing"} ${parsed.threadId}...`
  });
  return true;
}

for (const { bot } of botRuntimes) {
  bot.use(authMiddleware);

  bot.on("message", async (ctx) => {
    try {
      const parsedPayload = await parseTelegramMessage(ctx);
      if (!parsedPayload) {
        return;
      }

      const consumedAsFolderCreate = await maybeHandleSpawnDirectoryCreateInput(
        ctx,
        parsedPayload.botId,
        parsedPayload.chatId,
        parsedPayload.event.content,
        (text) => ctx.reply(text)
      );
      if (consumedAsFolderCreate) {
        return;
      }

      const terminalReplyInput =
        parsedPayload.event.reply_to !== null ? normalizeTerminalReplyInput(parsedPayload.event.content) : null;
      const parsedCommand = terminalReplyInput
        ? {
            intent: "terminal_input" as const,
            shouldForward: true,
            target: "active",
            threadId: null,
            spawnDir: null,
            monitorUpdatesEnabled: null,
            monitorUpdateIntervalSec: null,
            pushEnabled: null,
            mode: "bridge" as const,
            payloadContent: terminalReplyInput,
            picker: null,
            priority: null,
            autoApproveValue: null,
            autoApproveQuery: false
          }
        : parseSlashCommand(parsedPayload.event.content);
      interfaceLog.info(
        {
          channel: "telegram",
          bot_id: parsedPayload.botId,
          sender_id: parsedPayload.event.sender_id,
          raw_message_id: Number(parsedPayload.event.raw_message_id),
          intent: parsedCommand.intent,
          auth_result: "allowed"
        },
        "InboundUIEvent received"
      );

      if (parsedCommand.intent === "service_restart") {
        await handleRestartCommand(ctx);
        return;
      }

      if (parsedCommand.intent === "browse") {
        const session = beginBrowseSession(parsedPayload.botId, parsedPayload.chatId);
        const message = await ctx.reply(buildBrowsePrompt(session), {
          reply_markup: buildBrowseKeyboard(session)
        });
        session.pickerMessageId = String(message.message_id);
        return;
      }

      if (parsedCommand.picker) {
        await presentPickerFlow(parsedCommand, parsedPayload, (text, extra) => ctx.reply(text, extra));
        return;
      }

      if (!parsedCommand.shouldForward || parsedCommand.intent === "help") {
        await ctx.reply(getHelpMessage());
        return;
      }

      const hubMessage = toHubMessage(parsedCommand, parsedPayload);
      await sendHubMessage(hubMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      interfaceLog.error({ err: message }, "Failed to process Telegram message");
      await ctx.reply(`Failed to process message: ${message}`);
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    try {
      const data = ctx.callbackQuery.data;
      const handled =
        (await handleHubActionCallbackData(data, ctx)) ||
        (await handlePickerCallbackData(data, ctx));
      if (!handled) {
        await ctx.answerCallbackQuery({ text: "Unknown action" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      interfaceLog.error({ err: message }, "Failed to process callback query");
      await ctx.answerCallbackQuery({ text: "Action failed" });
    }
  });
}

let activeWebhookServer: WebhookServerLike | null = null;

function normalizeWebhookBasePath(webhookUrl: string): string {
  const pathname = new URL(webhookUrl).pathname.trim();
  if (!pathname || pathname === "/") {
    return "/webhook";
  }
  return pathname.endsWith("/") && pathname !== "/" ? pathname.slice(0, -1) : pathname;
}

export function buildWebhookRoutePath(webhookUrl: string, botId: string, runtimeCount: number): string {
  const basePath = normalizeWebhookBasePath(webhookUrl);
  return runtimeCount > 1 ? `${basePath}/${botId}` : basePath;
}

export function buildWebhookPublicUrl(webhookUrl: string, botId: string, runtimeCount: number): string {
  const url = new URL(webhookUrl);
  url.pathname = buildWebhookRoutePath(webhookUrl, botId, runtimeCount);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function createDefaultWebhookServer(handler: http.RequestListener): WebhookServerLike {
  return http.createServer(handler);
}

async function startLongPollingRuntimes(runtimes: InterfaceBotRuntime[], logger: InterfaceLogger): Promise<void> {
  await Promise.all(
    runtimes.map(async ({ bot, botId }) => {
      await bot.api.deleteWebhook({ drop_pending_updates: false });
      await bot.start({
        onStart: (me) => {
          logger.info(
            { bot_id: botId, username: me.username, telegram_bot_id: me.id },
            "Telegram bot started with long polling"
          );
        }
      });
    })
  );
}

async function startWebhookRuntimes(
  runtimes: InterfaceBotRuntime[],
  webhookUrl: string,
  webhookPort: number,
  webhookSecretToken: string,
  logger: InterfaceLogger,
  serverFactory: (handler: http.RequestListener) => WebhookServerLike,
  webhookHandlerFactory: (bot: TelegramBotLike, secretToken?: string) => WebhookHandler
): Promise<WebhookServerLike> {
  const handlers = new Map<string, WebhookHandler>();
  const secretToken = webhookSecretToken.trim() || undefined;

  for (const { bot, botId } of runtimes) {
    await bot.init();
    const routePath = buildWebhookRoutePath(webhookUrl, botId, runtimes.length);
    const publicUrl = buildWebhookPublicUrl(webhookUrl, botId, runtimes.length);
    handlers.set(routePath, webhookHandlerFactory(bot, secretToken));
    await bot.api.setWebhook(publicUrl, secretToken ? { secret_token: secretToken } : undefined);

    const botInfo = bot.botInfo;
    logger.info(
      {
        bot_id: botId,
        username: botInfo?.username,
        telegram_bot_id: botInfo?.id,
        webhook_url: publicUrl,
        webhook_path: routePath
      },
      "Telegram bot started with webhook"
    );
  }

  const server = serverFactory((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const handler = handlers.get(pathname);
    if (!handler) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    void Promise.resolve(handler(req, res)).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: message, path: pathname }, "Failed to process Telegram webhook request");
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end("Webhook processing failed");
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(webhookPort, resolve);
  });

  logger.info(
    {
      webhook_port: webhookPort,
      webhook_paths: [...handlers.keys()]
    },
    "Telegram webhook server listening"
  );

  return server;
}

export async function startInterface(options: StartInterfaceOptions = {}): Promise<void> {
  const runtimes = options.runtimes ?? (botRuntimes as InterfaceBotRuntime[]);
  const syncCommands = options.syncBotCommands ?? syncBotCommands;
  const webhookUrl = options.webhookUrl ?? config.WEBHOOK_URL;
  const webhookPort = options.webhookPort ?? config.WEBHOOK_PORT;
  const webhookSecretToken = options.webhookSecretToken ?? config.WEBHOOK_SECRET_TOKEN;
  const logger = options.logger ?? interfaceLog;
  const serverFactory = options.serverFactory ?? createDefaultWebhookServer;
  const webhookHandlerFactory =
    options.webhookHandlerFactory ??
    ((bot: TelegramBotLike, secretToken?: string) =>
      webhookCallback(bot as never, "http", { secretToken }) as unknown as WebhookHandler);

  await syncCommands();

  if (!webhookUrl.trim()) {
    await startLongPollingRuntimes(runtimes, logger);
    return;
  }

  activeWebhookServer = await startWebhookRuntimes(
    runtimes,
    webhookUrl,
    webhookPort,
    webhookSecretToken,
    logger,
    serverFactory,
    webhookHandlerFactory
  );
}

function stopInterface(): void {
  for (const { bot } of botRuntimes) {
    bot.stop();
  }

  if (activeWebhookServer) {
    activeWebhookServer.close();
    activeWebhookServer = null;
  }
}

process.once("SIGINT", () => {
  stopInterface();
});
process.once("SIGTERM", () => {
  stopInterface();
});

if (process.env.MERIDIAN_DISABLE_INTERFACE_AUTOSTART !== "true") {
  void startInterface();
}
