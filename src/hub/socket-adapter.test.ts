import assert from "node:assert/strict";
import { test } from "node:test";

import type { HubResult, ReplyChannel } from "../types";
import { SocketChannelAdapter } from "./socket-adapter";

test("SocketChannelAdapter.canHandle returns true only for socket channel", () => {
  const adapter = new SocketChannelAdapter();
  assert.equal(adapter.channel, "socket");
  assert.equal(adapter.canHandle({ channel: "socket", chat_id: "x", socket_path: "/tmp/x.sock" }), true);
  assert.equal(adapter.canHandle({ channel: "telegram", chat_id: "x" }), false);
  assert.equal(adapter.canHandle({ channel: "web", chat_id: "x" }), false);
});

test("SocketChannelAdapter.send throws when socket_path is missing", async () => {
  const adapter = new SocketChannelAdapter();
  const result: HubResult = {
    trace_id: "test-trace",
    thread_id: "test-thread",
    source: "codex",
    status: "success",
    content: "ok",
    attachments: [],
    timestamp: new Date().toISOString()
  };
  const replyChannel: ReplyChannel = { channel: "socket", chat_id: "x" };

  await assert.rejects(() => adapter.send(result, replyChannel), {
    message: "socket_path required for socket channel"
  });
});
