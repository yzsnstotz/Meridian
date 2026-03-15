import { createLogger } from "../../logger";
import type { HubResult, ReplyChannel } from "../../types";
import type { ChannelAdapter } from "../../hub/channel-adapter";

export class WebChannelAdapter implements ChannelAdapter {
  readonly channel = "web" as const;
  private readonly log = createLogger("hub");

  canHandle(replyChannel: ReplyChannel): boolean {
    return replyChannel.channel === "web";
  }

  async send(result: HubResult, replyChannel: ReplyChannel): Promise<void> {
    this.log.debug(
      {
        trace_id: result.trace_id,
        thread_id: result.thread_id,
        target: replyChannel.chat_id
      },
      "WebChannelAdapter: web channel results are delivered via SSE/WebSocket, not adapter send"
    );
  }
}
