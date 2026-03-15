import { randomUUID } from "node:crypto";

import { sendIpcRequest } from "../../../src/shared/ipc";
import type { HubMessage, HubResult } from "../../../src/types";

/**
 * Build a minimal HubMessage for integration tests.
 * reply_channel uses telegram:test so ResultSender can be no-op if we don't actually send to Telegram.
 */
export function buildHubMessage(overrides: Partial<HubMessage> & { intent: HubMessage["intent"] }): HubMessage {
  return {
    trace_id: randomUUID(),
    thread_id: overrides.thread_id ?? "codex_01",
    actor_id: "tg:123456789",
    intent: overrides.intent,
    target: overrides.target ?? "codex",
    payload: overrides.payload ?? { content: "", raw_message_id: "test-1", reply_to: null },
    mode: overrides.mode ?? "bridge",
    reply_channel: overrides.reply_channel ?? {
      channel: "telegram",
      chat_id: "telegram:123456789",
      message_id: "1",
      bot_id: "123456789"
    },
    suppress_reply: overrides.suppress_reply ?? true,
    ...overrides
  };
}

/**
 * Send a HubMessage to the Hub over Unix socket and return the HubResult.
 */
export async function sendHubIpc(socketPath: string, message: HubMessage): Promise<HubResult> {
  return sendIpcRequest<HubMessage, HubResult>(socketPath, message);
}
