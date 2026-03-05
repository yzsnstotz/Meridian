import { config } from "../config";
import { createLogger } from "../logger";
import { sendIpcMessage } from "../shared/ipc";
import type { HubMessage } from "../types";

const interfaceLog = createLogger("interface");

export async function sendHubMessage(message: HubMessage): Promise<void> {
  await sendIpcMessage(config.HUB_SOCKET_PATH, message);
  interfaceLog.debug(
    {
      trace_id: message.trace_id,
      thread_id: message.thread_id,
      intent: message.intent,
      target: message.target
    },
    "HubMessage forwarded to hub socket"
  );
}
