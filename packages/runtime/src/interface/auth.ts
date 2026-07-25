import type { Context, MiddlewareFn } from "grammy";
import { config } from "../config";
import { createLogger } from "../logger";

const interfaceLog = createLogger("interface");

function extractRawMessageId(ctx: Context): number | null {
  const message = ctx.message as { message_id?: number } | undefined;
  return typeof message?.message_id === "number" ? message.message_id : null;
}

export const authMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const senderId = ctx.from?.id;
  const rawMessageId = extractRawMessageId(ctx);

  if (!senderId || !config.ALLOWED_USER_IDS.includes(senderId)) {
    interfaceLog.warn(
      {
        channel: "telegram",
        sender_id: senderId ?? null,
        raw_message_id: rawMessageId,
        intent: null,
        auth_result: "denied"
      },
      "Inbound message denied by whitelist"
    );

    if (ctx.chat) {
      await ctx.reply("Access denied.");
    }
    return;
  }

  await next();
};
