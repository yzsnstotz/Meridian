// Inbound IPC frames for the hub use the wire envelope:
//   { auth: { caller_id, caller_key }, message: HubMessage }
// Outbound replies (HubResult) sent through SocketChannelAdapter remain bare,
// because the requesting socket is already authenticated. The wire-envelope
// helpers below are re-exported so router/server code can unwrap inbound
// frames without reaching into shared/.
import type { ChannelAdapter } from "./channel-adapter";

import {
  callerEnvelopeFromHttpHeaders,
  callerVersionFromHttpHeaders,
  unwrapWireFrame,
  wrapHubMessage,
  type WireAuth,
  type WireFrame
} from "../shared/caller-wire";
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

export {
  callerEnvelopeFromHttpHeaders,
  callerVersionFromHttpHeaders,
  unwrapWireFrame,
  wrapHubMessage,
  type WireAuth,
  type WireFrame
};
