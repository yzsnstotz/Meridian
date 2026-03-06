import { Bot } from "grammy";
import type { BotCommand } from "@grammyjs/types";
import { config } from "../config";

const BOT_COMMANDS: BotCommand[] = [
  { command: "spawn", description: "Spawn a new agent instance" },
  { command: "restart", description: "Rebuild and restart Meridian services" },
  { command: "browse", description: "Browse repo and return exact file/folder path" },
  { command: "kill", description: "Kill an existing instance" },
  { command: "status", description: "Get current instance status" },
  { command: "attach", description: "Attach this chat to a thread" },
  { command: "update", description: "Toggle monitor progress updates for a thread" },
  { command: "mupdate", description: "Send one manual progress update for a thread" },
  { command: "model", description: "Use provider model menu in active thread" },
  { command: "list", description: "List active instances" },
  { command: "help", description: "Show command usage" }
];

function extractBotIdFromToken(token: string): string {
  const [rawBotId] = token.trim().split(":");
  if (!rawBotId || !/^\d+$/.test(rawBotId)) {
    throw new Error("Telegram bot token must use format '<bot_id>:<secret>'");
  }
  return rawBotId;
}

function parseAdditionalBotTokens(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveConfiguredBotTokens(): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const token of [config.TELEGRAM_BOT_TOKEN, ...parseAdditionalBotTokens(config.TELEGRAM_BOT_TOKENS)]) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
  }

  return tokens;
}

export interface TelegramBotRuntime {
  bot: Bot;
  botId: string;
  token: string;
}

const resolvedRuntimes = resolveConfiguredBotTokens().map((token) => ({
  bot: new Bot(token),
  botId: extractBotIdFromToken(token),
  token
}));

const seenBotIds = new Set<string>();
for (const runtime of resolvedRuntimes) {
  if (seenBotIds.has(runtime.botId)) {
    throw new Error(`Duplicate Telegram bot_id detected in configured tokens: ${runtime.botId}`);
  }
  seenBotIds.add(runtime.botId);
}

export const botRuntimes: TelegramBotRuntime[] = resolvedRuntimes;

export async function syncBotCommands(): Promise<void> {
  await Promise.all(botRuntimes.map(({ bot }) => bot.api.setMyCommands(BOT_COMMANDS)));
}
