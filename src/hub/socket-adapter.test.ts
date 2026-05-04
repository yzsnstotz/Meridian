import assert from "node:assert/strict";
import { test } from "node:test";

import type { HubMessage, HubResult, ReplyChannel } from "../types";
import {
  SocketChannelAdapter,
  callerEnvelopeFromHttpHeaders,
  unwrapWireFrame,
  wrapHubMessage
} from "./socket-adapter";

function buildHubMessage(): HubMessage {
  return {
    trace_id: "00000000-0000-4000-8000-00000000abcd",
    thread_id: "thread-abcd",
    actor_id: "actor-1",
    intent: "list",
    target: "codex",
    mode: "bridge",
    payload: { content: "ping", attachments: [] },
    reply_channel: { channel: "socket", chat_id: "actor-1", socket_path: "/tmp/x.sock" }
  };
}

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

test("socket-adapter wire helpers round-trip a HubMessage and strip auth before dispatch", () => {
  const message = buildHubMessage();
  const wrapped = wrapHubMessage(message, {
    caller_id: "meridian-cli",
    caller_key: "wire-test-key",
    caller_label: "Meridian CLI"
  });

  const onWire = JSON.parse(JSON.stringify(wrapped)) as unknown;

  const unwrapped = unwrapWireFrame(onWire);
  assert.ok(unwrapped, "expected unwrap to produce a frame");

  // Simulate the dispatch path: only the bare HubMessage is forwarded to the
  // dispatcher. The auth metadata stays inside the envelope and never reaches
  // dispatcher arguments.
  const dispatched = unwrapped!.message;
  assert.equal((dispatched as Record<string, unknown>).auth, undefined);
  assert.equal(dispatched.intent, "list");
  assert.equal(dispatched.caller?.caller_id, "meridian-cli");
  assert.equal(dispatched.caller?.caller_label, "Meridian CLI");
  assert.equal(JSON.stringify(dispatched).includes("wire-test-key"), false);
  assert.equal(JSON.stringify(dispatched).includes("caller_key"), false);
});

test("socket-adapter wire helpers reject malformed inbound frames", () => {
  assert.equal(unwrapWireFrame(null), null);
  assert.equal(unwrapWireFrame({ message: buildHubMessage() }), null);
  assert.equal(unwrapWireFrame({ auth: {}, message: buildHubMessage() }), null);
});

test("callerEnvelopeFromHttpHeaders is reachable via socket-adapter re-export", () => {
  assert.deepEqual(
    callerEnvelopeFromHttpHeaders({
      "x-meridian-caller-id": "meridian-web",
      "x-meridian-caller-key": "k"
    }),
    { caller_id: "meridian-web", caller_key: "k" }
  );
  assert.equal(
    callerEnvelopeFromHttpHeaders({ "x-meridian-caller-id": "meridian-web" }),
    null
  );
});
