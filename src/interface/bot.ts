import { Bot } from "grammy";
import type { BotCommand } from "@grammyjs/types";
import { config } from "../config";

const BOT_COMMANDS: BotCommand[] = [
  { command: "spawn", description: "Spawn a new agent instance" },
  { command: "kill", description: "Kill an existing instance" },
  { command: "status", description: "Get current instance status" },
  { command: "attach", description: "Attach this chat to a thread" },
  { command: "model", description: "Switch provider for an existing thread" },
  { command: "list", description: "List active instances" },
  { command: "help", description: "Show command usage" }
];

export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

export async function syncBotCommands(): Promise<void> {
  await bot.api.setMyCommands(BOT_COMMANDS);
}
