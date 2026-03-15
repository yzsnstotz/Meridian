import type { ChannelAdapter } from "./channel-adapter";

import { sendIpcMessage } from "../shared/ipc";
import type { HubResult, ReplyChannel } from "../types";

export class SocketChannelAdapter implements ChannelAdapter {
  readonly channel = "socket" as const;

  canHandle(replyChannel: ReplyChannel): boolean {
    return replyChannel.channel === "socket";
  }

  async send(result: HubResult, replyChannel: ReplyChannel): Promise<void> {
    if (!replyChannel.socket_path) {
      throw new Error("socket_path required for socket channel");
    }

    await sendIpcMessage(replyChannel.socket_path, result);
  }
}
