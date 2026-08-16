import type { Channel, HubResult, ReplyChannel } from "../types";

export interface ChannelAdapter {
  readonly channel: Channel;
  canHandle(replyChannel: ReplyChannel): boolean;
  send(result: HubResult, replyChannel: ReplyChannel): Promise<void>;
}
