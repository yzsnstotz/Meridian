import { randomUUID } from "node:crypto";
import type { HubMessage } from "../types";
import { createLogger } from "../logger";
import { authMiddleware } from "./auth";
import { bot, syncBotCommands } from "./bot";
import { sendHubMessage } from "./ipc-sender";
import { parseTelegramMessage } from "./parser";
import { getHelpMessage, parseSlashCommand, type ParsedSlashCommand } from "./slash-handler";

const interfaceLog = createLogger("interface");

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
    reply_channel: {
      channel: "telegram",
      chat_id: payload.chatId,
      message_id: payload.event.raw_message_id
    }
  };
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

    const hubMessage = toHubMessage(parsedCommand, parsedPayload);
    await sendHubMessage(hubMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    interfaceLog.error({ err: message }, "Failed to process Telegram message");
    await ctx.reply(`Failed to process message: ${message}`);
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
