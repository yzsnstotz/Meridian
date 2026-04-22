import { config } from "../config";
import { createLogger } from "../logger";
import { sendIpcMessage, sendIpcRequest, IPC_RUN_REQUEST_TIMEOUT_MS } from "../shared/ipc";
import { HubResultSchema, type HubMessage, type HubResult } from "../types";

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

export async function requestHubMessage(message: HubMessage, timeoutMs?: number): Promise<HubResult> {
  const response = await sendIpcRequest<HubMessage, HubResult>(config.HUB_SOCKET_PATH, message, timeoutMs);
  return HubResultSchema.parse(response);
}

export async function requestHubRunMessage(message: HubMessage): Promise<HubResult> {
  return requestHubMessage(message, IPC_RUN_REQUEST_TIMEOUT_MS);
}
