import {
  HubResultSchema,
  ReplyChannelSchema,
  type HubResult,
  type ReplyChannel
} from "../types";
import type { ChannelAdapter } from "./channel-adapter";

// Re-export Telegram-specific functions that other modules depend on.
// The implementations now live in interface/adapters/telegram-adapter.ts.
export {
  splitTextForTelegram,
  decorateTelegramResultText,
  resolveTelegramDetailRecord,
  shouldPushTelegramProactive,
  TelegramChannelAdapter,
  type TelegramAdapterOptions as ResultSenderOptions
} from "../interface/adapters/telegram-adapter";

export class ResultSender {
  private readonly adapters: ChannelAdapter[];

  constructor(adapters: ChannelAdapter[]) {
    this.adapters = adapters;
  }

  async sendResult(rawResult: HubResult, rawReplyChannel: ReplyChannel): Promise<void> {
    const result = HubResultSchema.parse(rawResult);
    const replyChannel = ReplyChannelSchema.parse(rawReplyChannel);

    const adapter = this.adapters.find((a) => a.canHandle(replyChannel));
    if (!adapter) {
      throw new Error(`No adapter registered for channel: ${replyChannel.channel}`);
    }

    await adapter.send(result, replyChannel);
  }
}
