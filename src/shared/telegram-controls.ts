import { config } from "../config";
import type { TelegramInlineKeyboard } from "../types";

export const HUB_ACTION_CALLBACK_PREFIX = "hub";

export type HubActionCallbackIntent = "reboot" | "kill";

export function buildHubActionCallbackData(intent: HubActionCallbackIntent, threadId: string): string {
  return `${HUB_ACTION_CALLBACK_PREFIX}:${intent}:${threadId}`;
}

export function parseHubActionCallbackData(
  data: string
): { intent: HubActionCallbackIntent; threadId: string } | null {
  const parts = data.split(":");
  if (parts[0] !== HUB_ACTION_CALLBACK_PREFIX) {
    return null;
  }

  const intent = parts[1];
  const threadId = parts.slice(2).join(":").trim();
  if ((intent !== "reboot" && intent !== "kill") || !threadId) {
    return null;
  }

  return { intent, threadId };
}

export function buildWebGuiUrl(threadId: string): string {
  const rawHost = config.WEB_GUI_HOST.trim();
  if (!rawHost) {
    throw new Error("WEB_GUI_HOST is required for /gui");
  }

  const protocol = config.WEB_GUI_HTTPS ? "https" : "http";
  const normalizedHost = rawHost.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const url = new URL(`${protocol}://${normalizedHost}`);
  const isDefaultPort =
    (url.protocol === "https:" && config.WEB_GUI_PORT === 443) ||
    (url.protocol === "http:" && config.WEB_GUI_PORT === 80);

  if (!url.port && !isDefaultPort) {
    url.port = String(config.WEB_GUI_PORT);
  }

  url.searchParams.set("thread", threadId);
  if (config.WEB_GUI_TOKEN.trim()) {
    url.searchParams.set("token", config.WEB_GUI_TOKEN.trim());
  }
  return url.toString();
}

export function tryBuildGuiInlineKeyboard(threadId: string): TelegramInlineKeyboard | undefined {
  try {
    return {
      inline_keyboard: [[{ text: "🖥 打开 GUI", url: buildWebGuiUrl(threadId) }]]
    };
  } catch {
    return undefined;
  }
}

export function buildAgentErrorInlineKeyboard(threadId: string): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "🔄 Reboot", callback_data: buildHubActionCallbackData("reboot", threadId) },
        { text: "❌ Kill", callback_data: buildHubActionCallbackData("kill", threadId) }
      ]
    ]
  };
}
