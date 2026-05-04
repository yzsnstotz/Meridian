import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { HubMessage, HubResult } from "../types";
import { IpcSender } from "./ipc-sender";

interface TestServer {
  socketPath: string;
  close: () => Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function startSocketServer(
  onPayload: (raw: string, socket: net.Socket) => void
): Promise<TestServer> {
  const dir = mkdtempSync(path.join(tmpdir(), "ipc-sender-test-"));
  const socketPath = path.join(dir, "hub.sock");
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding("utf8");
    socket.on("error", () => {
      // Client may close before server writes; ignore.
    });
    let raw = "";
    socket.on("data", (chunk: string) => {
      raw += chunk;
    });
    socket.on("end", () => {
      onPayload(raw, socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function buildMessage(): HubMessage {
  return {
    trace_id: "00000000-0000-4000-8000-000000000099",
    thread_id: "thread-99",
    actor_id: "actor-99",
    intent: "list",
    target: "codex",
    mode: "bridge",
    payload: { content: "ping", attachments: [] },
    reply_channel: { channel: "socket", chat_id: "actor-99", socket_path: "/tmp/x.sock" }
  };
}

function buildResultJson(message: HubMessage): string {
  const result: HubResult = {
    trace_id: message.trace_id,
    thread_id: message.thread_id,
    source: "codex",
    status: "success",
    content: "ok",
    attachments: [],
    timestamp: new Date().toISOString()
  };
  return JSON.stringify(result);
}

test("IpcSender.send wraps HubMessage in {auth, message} envelope and injects caller identity", async () => {
  const captured = createDeferred<unknown>();
  const server = await startSocketServer((raw, socket) => {
    captured.resolve(JSON.parse(raw));
    if (socket.writable) {
      socket.end();
    }
  });

  try {
    const sender = new IpcSender({ socketPath: server.socketPath });
    sender.setCallerIdentity({
      caller_id: "meridian-cli",
      caller_key: "secret-cli-key",
      caller_label: "Meridian CLI",
      caller_version: "1.0.0"
    });

    await sender.send(buildMessage());

    const payload = await captured.promise;
    assert.ok(payload && typeof payload === "object", "expected payload object");
    const frame = payload as { auth: { caller_id: string; caller_key: string }; message: HubMessage };
    assert.equal(frame.auth.caller_id, "meridian-cli");
    assert.equal(frame.auth.caller_key, "secret-cli-key");
    assert.equal(frame.message.intent, "list");
    assert.equal(frame.message.caller?.caller_id, "meridian-cli");
    assert.equal(frame.message.caller?.caller_label, "Meridian CLI");
    assert.equal(frame.message.caller?.caller_version, "1.0.0");
    assert.equal(JSON.stringify(frame.message.caller).includes("caller_key"), false);
  } finally {
    await server.close();
  }
});

test("IpcSender.send throws caller_identity_not_set before setCallerIdentity is called", async () => {
  const sender = new IpcSender({ socketPath: "/tmp/never-used.sock" });
  await assert.rejects(() => sender.send(buildMessage()), /caller_identity_not_set/);
});

test("IpcSender.request also wraps and parses response", async () => {
  const server = await startSocketServer((raw, socket) => {
    const parsed = JSON.parse(raw) as { auth: unknown; message: HubMessage };
    assert.ok(parsed.auth, "auth must be present");
    socket.end(buildResultJson(parsed.message));
  });

  try {
    const sender = new IpcSender({ socketPath: server.socketPath });
    sender.setCallerIdentity({
      caller_id: "meridian-web",
      caller_key: "wkey",
      caller_label: "Meridian Web"
    });
    const message = buildMessage();
    const result = await sender.request(message);
    assert.equal(result.trace_id, message.trace_id);
    assert.equal(result.status, "success");
  } finally {
    await server.close();
  }
});

test("IpcSender.setCallerIdentity rejects empty caller_id / caller_key / caller_label", () => {
  const sender = new IpcSender({ socketPath: "/tmp/never-used.sock" });
  assert.throws(
    () => sender.setCallerIdentity({ caller_id: "", caller_key: "k", caller_label: "L" }),
    /caller_identity_required/
  );
  assert.throws(
    () => sender.setCallerIdentity({ caller_id: "id", caller_key: "", caller_label: "L" }),
    /caller_identity_required/
  );
  assert.throws(
    () => sender.setCallerIdentity({ caller_id: "id", caller_key: "k", caller_label: "" }),
    /caller_identity_required/
  );
});

test("clearCallerIdentity puts the sender back into the unset state", async () => {
  const sender = new IpcSender({ socketPath: "/tmp/never-used.sock" });
  sender.setCallerIdentity({ caller_id: "id", caller_key: "k", caller_label: "L" });
  assert.equal(sender.hasCallerIdentity(), true);
  sender.clearCallerIdentity();
  assert.equal(sender.hasCallerIdentity(), false);
  await assert.rejects(() => sender.send(buildMessage()), /caller_identity_not_set/);
});

test("caller_key is never persisted into message.caller (key only lives in auth)", async () => {
  const captured = createDeferred<unknown>();
  const server = await startSocketServer((raw, socket) => {
    captured.resolve(JSON.parse(raw));
    if (socket.writable) {
      socket.end();
    }
  });

  try {
    const sender = new IpcSender({ socketPath: server.socketPath });
    sender.setCallerIdentity({
      caller_id: "meridian-admin",
      caller_key: "topsecret-admin",
      caller_label: "Meridian Admin"
    });
    await sender.send(buildMessage());

    const payload = await captured.promise;
    const frame = payload as { auth: unknown; message: HubMessage };
    const messageJson = JSON.stringify(frame.message);
    assert.equal(messageJson.includes("topsecret-admin"), false);
    assert.equal(messageJson.includes("caller_key"), false);
  } finally {
    await server.close();
  }
});
