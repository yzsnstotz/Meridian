import type { ReplyChannel } from "../types";
import { ReplyChannelSchema } from "../types";

function parseCommaSeparatedNumericIds(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }

  return raw
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => /^\d+$/.test(segment));
}

/** Hub-style `ALLOWED_USER_IDS` (comma-separated Telegram user ids). */
export function listAllowedUserIdsFromEnv(): string[] {
  return parseCommaSeparatedNumericIds(process.env.ALLOWED_USER_IDS);
}

/** Telegram bot numeric id is the segment before ':' in each BotFather token. */
export function listTelegramBotNumericIdsFromEnv(): string[] {
  const collected: string[] = [];

  const pushFromToken = (token: string) => {
    const segment = token.trim().split(":")[0]?.trim();
    if (segment && /^\d+$/.test(segment)) {
      collected.push(segment);
    }
  };

  const single = process.env.TELEGRAM_BOT_TOKEN;
  if (single) {
    pushFromToken(single);
  }

  const list = process.env.TELEGRAM_BOT_TOKENS;
  if (list) {
    for (const token of list.split(",")) {
      pushFromToken(token);
    }
  }

  return [...new Set(collected)];
}

function channelDedupeKey(channel: ReplyChannel): string {
  return `${channel.channel}|${channel.chat_id}|${channel.bot_id ?? ""}`;
}

/**
 * Telegram reply targets derived from Hub-style env (ALLOWED_USER_IDS, TELEGRAM_BOT_TOKEN(s)).
 * Shown in the roles GUI when Hub does not list channels or alongside Hub channels.
 */
export function buildEnvReplyChannelPresets(): ReplyChannel[] {
  const userIds = listAllowedUserIdsFromEnv();
  if (userIds.length === 0) {
    return [];
  }

  const botIds = listTelegramBotNumericIdsFromEnv();
  const presets: ReplyChannel[] = [];

  if (botIds.length === 0) {
    for (const userId of userIds) {
      presets.push(
        ReplyChannelSchema.parse({
          channel: "telegram",
          chat_id: `telegram:${userId}`,
          chat_name: `Allowed operator ${userId} (ALLOWED_USER_IDS)`
        })
      );
    }
    return presets;
  }

  for (const userId of userIds) {
    for (const botId of botIds) {
      const label =
        botIds.length === 1 && userIds.length === 1
          ? `Allowed operator ${userId} (ALLOWED_USER_IDS · bot ${botId})`
          : `Allowed operator ${userId} · bot ${botId}`;

      presets.push(
        ReplyChannelSchema.parse({
          channel: "telegram",
          chat_id: `telegram:${userId}`,
          bot_id: botId,
          chat_name: label
        })
      );
    }
  }

  return presets;
}

export function mergeReplyChannelLists(hubChannels: ReplyChannel[], envChannels: ReplyChannel[]): ReplyChannel[] {
  const seen = new Set<string>();
  const merged: ReplyChannel[] = [];

  for (const channel of hubChannels) {
    const key = channelDedupeKey(channel);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(channel);
  }

  for (const channel of envChannels) {
    const key = channelDedupeKey(channel);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(channel);
  }

  return merged;
}
