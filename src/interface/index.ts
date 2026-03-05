import { spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { AgentInstanceSchema, type AgentInstance, type AgentType, type HubMessage, type Intent } from "../types";
import { createLogger } from "../logger";
import { authMiddleware } from "./auth";
import { bot, syncBotCommands } from "./bot";
import { requestHubMessage, sendHubMessage } from "./ipc-sender";
import { parseTelegramMessage } from "./parser";
import { getHelpMessage, parseSlashCommand, type ParsedSlashCommand } from "./slash-handler";

const interfaceLog = createLogger("interface");
const SPAWN_TYPES: AgentType[] = ["claude", "codex", "gemini", "cursor"];
const CALLBACK_PREFIX = "pk";
const LIVE_INSTANCE_STATUSES = new Set<AgentInstance["status"]>(["idle", "running", "waiting"]);
const SPAWN_DIR_ROOT = "/Users/yzliu/work";
const SPAWN_DIR_MAX_BUTTONS = 24;
const SPAWN_DIR_SESSION_TTL_MS = 15 * 60 * 1000;

interface SpawnDirectorySession {
  sessionId: string;
  chatId: string;
  type: AgentType;
  mode: "bridge" | "pane_bridge";
  currentDir: string;
  entries: string[];
  createdAtMs: number;
}

const spawnDirectorySessions = new Map<string, SpawnDirectorySession>();

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

function toHubMessage(
  parsedCommand: ParsedSlashCommand,
  payload: Awaited<ReturnType<typeof parseTelegramMessage>>
): HubMessage {
  if (!payload) {
    throw new Error("Cannot build HubMessage from empty payload");
  }

  if (parsedCommand.intent === "help" || parsedCommand.intent === "restart") {
    throw new Error(`${parsedCommand.intent} command should not be forwarded`);
  }

  const threadId = resolveThreadId(parsedCommand, payload.event.reply_to);
  const target =
    parsedCommand.target === "active" ? (payload.event.reply_to ?? "active") : parsedCommand.target;

  return {
    trace_id: randomUUID(),
    thread_id: threadId,
    actor_id: "owner",
    intent: parsedCommand.intent,
    target,
    payload: {
      content: parsedCommand.payloadContent || payload.event.content,
      attachments: payload.event.attachments,
      raw_message_id: payload.event.raw_message_id,
      reply_to: payload.event.reply_to,
      spawn_dir: parsedCommand.spawnDir ?? undefined
    },
    mode: parsedCommand.mode,
    suppress_reply: false,
    reply_channel: {
      channel: "telegram",
      chat_id: payload.chatId,
      message_id: payload.event.raw_message_id
    }
  };
}

function buildActionHubMessage(params: {
  chatId: string;
  messageId?: string;
  intent: Intent;
  threadId: string;
  target: string;
  mode?: "bridge" | "pane_bridge";
  spawnDir?: string;
  suppressReply?: boolean;
}): HubMessage {
  return {
    trace_id: randomUUID(),
    thread_id: params.threadId,
    actor_id: "owner",
    intent: params.intent,
    target: params.target,
    payload: {
      content: "",
      attachments: [],
      raw_message_id: params.messageId,
      reply_to: null,
      spawn_dir: params.spawnDir
    },
    mode: params.mode ?? "bridge",
    suppress_reply: params.suppressReply ?? false,
    reply_channel: {
      channel: "telegram",
      chat_id: params.chatId,
      message_id: params.messageId
    }
  };
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

function pruneSpawnDirectorySessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of spawnDirectorySessions.entries()) {
    if (now - session.createdAtMs > SPAWN_DIR_SESSION_TTL_MS) {
      spawnDirectorySessions.delete(sessionId);
    }
  }
}

function buildSpawnDirectoryKeyboard(session: SpawnDirectorySession): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keyboard.text("Use This Folder", `${CALLBACK_PREFIX}:spawn_dir:${session.sessionId}:select`).row();
  if (path.resolve(session.currentDir) !== path.resolve(SPAWN_DIR_ROOT)) {
    keyboard.text("Up", `${CALLBACK_PREFIX}:spawn_dir:${session.sessionId}:up`).row();
  }

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
    session.entries.length === 0 ? "No child folders. Choose Use This Folder or Up." : "Choose a folder:"
  ].join("\n");
}

function beginSpawnDirectorySession(
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
    chatId,
    type,
    mode,
    currentDir: initialDir,
    entries: listDirectoriesUnder(initialDir),
    createdAtMs: Date.now()
  };
  spawnDirectorySessions.set(sessionId, session);
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

function getSpawnDirectorySession(sessionId: string, chatId: string): SpawnDirectorySession {
  pruneSpawnDirectorySessions();
  const session = spawnDirectorySessions.get(sessionId);
  if (!session) {
    throw new Error("Spawn directory picker expired. Run /spawn again.");
  }
  if (session.chatId !== chatId) {
    throw new Error("Spawn directory picker does not belong to this chat.");
  }
  return session;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

async function handleRestartCommand(ctx: Context): Promise<void> {
  const projectRoot = process.cwd();
  const scriptPath = path.resolve(projectRoot, "rebuild-restart.sh");
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Restart script not found: ${scriptPath}`);
  }

  const restartLogPath = path.join("/tmp", `meridian-restart-${Date.now()}.log`);
  await ctx.reply(`Restarting services via rebuild script. Log: ${restartLogPath}`);

  setTimeout(() => {
    const command = `/bin/bash ${shellEscape(scriptPath)} > ${shellEscape(restartLogPath)} 2>&1`;
    const child = spawnProcess("/bin/zsh", ["-lc", command], {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  }, 250);
}

function buildThreadPickerKeyboard(instances: AgentInstance[], action: "attach" | "kill" | "model_thread"): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const instance of instances) {
    const label = `${instance.thread_id} (${instance.agent_type}, ${instance.mode})`;
    keyboard.text(label, `${CALLBACK_PREFIX}:${action}:${instance.thread_id}`).row();
  }
  return keyboard;
}

function buildModelTypeKeyboard(threadId: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const type of SPAWN_TYPES) {
    keyboard.text(type, `${CALLBACK_PREFIX}:model_set:${threadId}:${type}`);
  }
  return keyboard;
}

async function requestLiveInstances(chatId: string, messageId?: string): Promise<AgentInstance[]> {
  const response = await requestHubMessage(
    buildActionHubMessage({
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
  const instances = AgentInstanceSchema.array().parse(parsed);
  return instances.filter((instance) => LIVE_INSTANCE_STATUSES.has(instance.status));
}

async function presentPickerFlow(
  parsedCommand: ParsedSlashCommand,
  payload: NonNullable<Awaited<ReturnType<typeof parseTelegramMessage>>>,
  reply: (text: string, extra?: Parameters<typeof bot.api.sendMessage>[2]) => Promise<unknown>
): Promise<void> {
  const messageId = payload.event.raw_message_id;
  const chatId = payload.chatId;

  if (parsedCommand.picker === "spawn") {
    await reply("Choose provider:", { reply_markup: buildSpawnProviderKeyboard() });
    return;
  }

  if (parsedCommand.picker === "attach" || parsedCommand.picker === "kill" || parsedCommand.picker === "switch_model") {
    if (parsedCommand.picker === "switch_model" && parsedCommand.threadId) {
      await reply(`Thread: ${parsedCommand.threadId}\nChoose provider:`, {
        reply_markup: buildModelTypeKeyboard(parsedCommand.threadId)
      });
      return;
    }

    const instances = await requestLiveInstances(chatId, messageId);
    if (instances.length === 0) {
      await reply("No active live threads found. Use /spawn first.");
      return;
    }

    if (parsedCommand.picker === "attach") {
      await reply("Choose thread to attach:", { reply_markup: buildThreadPickerKeyboard(instances, "attach") });
      return;
    }
    if (parsedCommand.picker === "kill") {
      await reply("Choose thread to kill:", { reply_markup: buildThreadPickerKeyboard(instances, "kill") });
      return;
    }

    await reply("Choose thread to switch model:", { reply_markup: buildThreadPickerKeyboard(instances, "model_thread") });
    return;
  }
}

async function handlePickerCallbackData(data: string, ctx: Context): Promise<boolean> {
  if (!data.startsWith(`${CALLBACK_PREFIX}:`)) {
    return false;
  }

  const parts = data.split(":");
  const chatId = ctx.chat?.id ? String(ctx.chat.id) : null;
  const callbackMessageId =
    "callbackQuery" in ctx && ctx.callbackQuery?.message && "message_id" in ctx.callbackQuery.message
      ? String(ctx.callbackQuery.message.message_id)
      : undefined;
  if (!chatId) {
    await ctx.answerCallbackQuery({ text: "Chat id missing" });
    return true;
  }

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

  if (action === "spawn_mode" && parts[2] && parts[3]) {
    const type = parts[2];
    const mode = parts[3];
    if (!isAgentType(type) || !isBridgeMode(mode)) {
      await ctx.answerCallbackQuery({ text: "Invalid spawn option" });
      return true;
    }
    const session = beginSpawnDirectorySession(chatId, type, mode);
    await ctx.editMessageText(buildSpawnDirectoryPrompt(session), {
      reply_markup: buildSpawnDirectoryKeyboard(session)
    });
    await ctx.answerCallbackQuery();
    return true;
  }

  if (action === "spawn_dir" && parts[2] && parts[3]) {
    const sessionId = parts[2];
    const operation = parts[3];
    const session = getSpawnDirectorySession(sessionId, chatId);

    if (operation === "cancel") {
      spawnDirectorySessions.delete(sessionId);
      await ctx.editMessageText("Spawn cancelled.");
      await ctx.answerCallbackQuery();
      return true;
    }

    if (operation === "select") {
      await sendHubMessage(
        buildActionHubMessage({
          chatId,
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

    if (operation === "open" && parts[4]) {
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

  if ((action === "attach" || action === "kill") && parts[2]) {
    const threadId = parts[2];
    await sendHubMessage(
      buildActionHubMessage({
        chatId,
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

  if (action === "model_thread" && parts[2]) {
    const threadId = parts[2];
    await ctx.editMessageText(`Thread: ${threadId}\nChoose provider:`, { reply_markup: buildModelTypeKeyboard(threadId) });
    await ctx.answerCallbackQuery();
    return true;
  }

  if (action === "model_set" && parts[2] && parts[3]) {
    const threadId = parts[2];
    const type = parts[3];
    if (!isAgentType(type)) {
      await ctx.answerCallbackQuery({ text: "Invalid provider" });
      return true;
    }
    await sendHubMessage(
      buildActionHubMessage({
        chatId,
        messageId: callbackMessageId,
        intent: "switch_model",
        threadId,
        target: type
      })
    );
    await ctx.editMessageText(`Switching ${threadId} -> ${type}...`);
    await ctx.answerCallbackQuery();
    return true;
  }

  await ctx.answerCallbackQuery({ text: "Unsupported picker action" });
  return true;
}

bot.use(authMiddleware);

bot.on("message", async (ctx) => {
  try {
    const parsedPayload = await parseTelegramMessage(ctx);
    if (!parsedPayload) {
      return;
    }

    const parsedCommand = parseSlashCommand(parsedPayload.event.content);
    interfaceLog.info(
      {
        channel: "telegram",
        sender_id: parsedPayload.event.sender_id,
        raw_message_id: Number(parsedPayload.event.raw_message_id),
        intent: parsedCommand.intent,
        auth_result: "allowed"
      },
      "InboundUIEvent received"
    );

    if (parsedCommand.intent === "restart") {
      await handleRestartCommand(ctx);
      return;
    }

    if (!parsedCommand.shouldForward || parsedCommand.intent === "help") {
      await ctx.reply(getHelpMessage());
      return;
    }

    if (parsedCommand.picker) {
      await presentPickerFlow(parsedCommand, parsedPayload, (text, extra) => ctx.reply(text, extra));
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
    const handled = await handlePickerCallbackData(data, ctx);
    if (!handled) {
      await ctx.answerCallbackQuery({ text: "Unknown action" });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    interfaceLog.error({ err: message }, "Failed to process callback query");
    await ctx.answerCallbackQuery({ text: "Action failed" });
  }
});

async function startInterface(): Promise<void> {
  await syncBotCommands();
  await bot.start({
    onStart: (me) => {
      interfaceLog.info({ bot_id: me.id, username: me.username }, "Telegram bot started with long polling");
    }
  });
}

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

void startInterface();
