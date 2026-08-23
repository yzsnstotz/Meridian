import assert from "node:assert/strict";
import { test } from "node:test";

import type { HubMessage } from "../types";
import {
  CALLER_HTTP_HEADERS,
  callerEnvelopeFromHttpHeaders,
  callerVersionFromHttpHeaders,
  unwrapWireFrame,
  wrapHubMessage
} from "./caller-wire";

function buildMessage(): HubMessage {
  return {
    trace_id: "00000000-0000-4000-8000-000000000001",
    thread_id: "thread-1",
    actor_id: "actor-1",
    intent: "list",
    target: "codex",
    mode: "bridge",
    payload: { content: "hello", attachments: [] },
    reply_channel: { channel: "socket", chat_id: "actor-1", socket_path: "/tmp/x.sock" }
  };
}

test("wrapHubMessage attaches auth + injects message.caller without key", () => {
  const message = buildMessage();
  const wrapped = wrapHubMessage(message, {
    caller_id: "meridian-cli",
    caller_key: "secret-key",
    caller_label: "Meridian CLI",
    caller_version: "1.2.3"
  });

  assert.deepEqual(wrapped.auth, { caller_id: "meridian-cli", caller_key: "secret-key" });
  assert.equal(wrapped.message.caller?.caller_id, "meridian-cli");
  assert.equal(wrapped.message.caller?.caller_label, "Meridian CLI");
  assert.equal(wrapped.message.caller?.caller_version, "1.2.3");
  assert.equal(JSON.stringify(wrapped.message.caller).includes("caller_key"), false);
  assert.equal(JSON.stringify(wrapped.message.caller).includes("secret-key"), false);
});

test("wrapHubMessage throws when identity is missing required fields", () => {
  const message = buildMessage();
  assert.throws(
    () => wrapHubMessage(message, { caller_id: "", caller_key: "k" }),
    /caller_identity_required/
  );
  assert.throws(
    () => wrapHubMessage(message, { caller_id: "id", caller_key: "" }),
    /caller_identity_required/
  );
});

test("unwrapWireFrame returns parsed pair for valid envelope", () => {
  const message = buildMessage();
  const wrapped = wrapHubMessage(message, {
    caller_id: "meridian-web",
    caller_key: "wkey"
  });
  const serialized = JSON.parse(JSON.stringify(wrapped)) as unknown;
  const unwrapped = unwrapWireFrame(serialized);
  assert.ok(unwrapped, "expected unwrap to succeed");
  assert.equal(unwrapped!.auth.caller_id, "meridian-web");
  assert.equal(unwrapped!.auth.caller_key, "wkey");
  assert.equal(unwrapped!.message.intent, "list");
});

test("unwrapWireFrame rejects malformed payloads", () => {
  assert.equal(unwrapWireFrame(null), null);
  assert.equal(unwrapWireFrame("not-an-object"), null);
  assert.equal(unwrapWireFrame({ message: buildMessage() }), null);
  assert.equal(
    unwrapWireFrame({ auth: { caller_id: "x" }, message: buildMessage() }),
    null
  );
  assert.equal(
    unwrapWireFrame({ auth: { caller_id: "x", caller_key: 9 }, message: buildMessage() }),
    null
  );
  assert.equal(
    unwrapWireFrame({ auth: { caller_id: "x", caller_key: "k" }, message: { intent: "list" } }),
    null
  );
});

test("auth is independent of injected message.caller (no caller_key leak)", () => {
  const message = buildMessage();
  const wrapped = wrapHubMessage(message, {
    caller_id: "meridian-admin",
    caller_key: "topsecret",
    caller_label: "Meridian Admin"
  });
  const json = JSON.stringify(wrapped.message);
  assert.equal(json.includes("topsecret"), false);
  assert.equal(json.includes("caller_key"), false);
});

test("callerEnvelopeFromHttpHeaders does case-insensitive lookup", () => {
  const result = callerEnvelopeFromHttpHeaders({
    "x-meridian-caller-id": "meridian-cli",
    "X-Meridian-Caller-Key": "k1",
    "content-type": "application/json"
  });
  assert.deepEqual(result, { caller_id: "meridian-cli", caller_key: "k1" });
});

test("callerEnvelopeFromHttpHeaders returns null when either header missing or empty", () => {
  assert.equal(
    callerEnvelopeFromHttpHeaders({ "x-meridian-caller-key": "k" }),
    null
  );
  assert.equal(
    callerEnvelopeFromHttpHeaders({ "x-meridian-caller-id": "id" }),
    null
  );
  assert.equal(
    callerEnvelopeFromHttpHeaders({
      "x-meridian-caller-id": "  ",
      "x-meridian-caller-key": "k"
    }),
    null
  );
  assert.equal(callerEnvelopeFromHttpHeaders({}), null);
});

test("callerEnvelopeFromHttpHeaders accepts array-valued header (Node http normalizes some)", () => {
  const result = callerEnvelopeFromHttpHeaders({
    "x-meridian-caller-id": ["meridian-cli"],
    "x-meridian-caller-key": ["abc"]
  });
  assert.deepEqual(result, { caller_id: "meridian-cli", caller_key: "abc" });
});

test("callerVersionFromHttpHeaders is independent of id/key headers", () => {
  assert.equal(
    callerVersionFromHttpHeaders({ "x-meridian-caller-version": "0.9.1" }),
    "0.9.1"
  );
  assert.equal(callerVersionFromHttpHeaders({}), null);
});

test("CALLER_HTTP_HEADERS uses the exact case mandated by Playbook §3.7", () => {
  assert.equal(CALLER_HTTP_HEADERS.id, "X-Meridian-Caller-Id");
  assert.equal(CALLER_HTTP_HEADERS.key, "X-Meridian-Caller-Key");
  assert.equal(CALLER_HTTP_HEADERS.version, "X-Meridian-Caller-Version");
});
