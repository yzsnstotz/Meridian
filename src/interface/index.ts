import { randomUUID } from "node:crypto";
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

  if (parsedCommand.intent === "help") {
    throw new Error("help command should not be forwarded");
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
      reply_to: payload.event.reply_to
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
      reply_to: null
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
  return instances.filter((instance) => instance.status !== "stopped");
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
    await sendHubMessage(
      buildActionHubMessage({
        chatId,
        messageId: callbackMessageId,
        intent: "spawn",
        threadId: "pending",
        target: type,
        mode
      })
    );
    await ctx.editMessageText(`Spawning ${type} (${mode})...`);
    await ctx.answerCallbackQuery();
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
