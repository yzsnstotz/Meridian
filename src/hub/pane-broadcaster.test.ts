import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { AgentInstance, PaneOutputChunk } from "../types";
import { PaneBroadcaster } from "./pane-broadcaster";

class FakeSocket extends EventEmitter {
  writable = true;
  destroyed = false;
  readonly writes: string[] = [];

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }

  end(chunk?: string): void {
    if (chunk) {
      this.writes.push(chunk);
    }
    this.writable = false;
    this.destroyed = true;
    this.emit("close");
  }
}

function buildPaneBridgeInstance(threadId: string): AgentInstance {
  return {
    thread_id: threadId,
    agent_type: "codex",
    mode: "pane_bridge",
    socket_path: "/tmp/agentapi.sock",
    working_dir: "/tmp",
    pid: 123,
    tmux_pane: `agent_${threadId}`,
    status: "running",
    created_at: new Date().toISOString(),
    restart_safe: true
  };
}

function parseSocketMessages(socket: FakeSocket): Array<PaneOutputChunk | Record<string, unknown>> {
  return socket.writes
    .flatMap((entry) => entry.split("\n"))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => JSON.parse(entry) as PaneOutputChunk | Record<string, unknown>);
}

async function waitFor(condition: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for pane output");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("PaneBroadcaster replays recent pane output and streams appended chunks", async () => {
  const logDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-pane-"));
  const threadId = "codex_01";
  const logPath = path.join(logDir, `pane-${threadId}.log`);
  await fs.promises.writeFile(logPath, "line 1\nline 2\n");

  const broadcaster = new PaneBroadcaster({ logDir });
  const socket = new FakeSocket();

  await broadcaster.subscribe(socket as never, buildPaneBridgeInstance(threadId), {
    type: "subscribe_pane_output",
    thread_id: threadId,
    replay_lines: 1
  });

  await fs.promises.appendFile(logPath, "line 3\n");
  await waitFor(() => socket.writes.length >= 2);

  const messages = parseSocketMessages(socket);
  assert.equal((messages[0] as PaneOutputChunk).chunk, "line 2");
  assert.equal((messages[1] as PaneOutputChunk).chunk, "line 3\n");

  broadcaster.close();
  await fs.promises.rm(logDir, { recursive: true, force: true });
});

test("PaneBroadcaster returns not_available for bridge instances", async () => {
  const broadcaster = new PaneBroadcaster({ logDir: os.tmpdir() });
  const result = await broadcaster.subscribe(new FakeSocket() as never, {
    ...buildPaneBridgeInstance("codex_01"),
    mode: "bridge",
    tmux_pane: null
  }, {
    type: "subscribe_pane_output",
    thread_id: "codex_01"
  });

  assert.equal(result.kind, "not_available");
  assert.equal(result.payload.type, "not_available");
});

test("PaneBroadcaster cleans up subscriptions when the socket closes", async () => {
  const logDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-pane-"));
  const threadId = "codex_01";
  const logPath = path.join(logDir, `pane-${threadId}.log`);
  await fs.promises.writeFile(logPath, "seed\n");

  const broadcaster = new PaneBroadcaster({ logDir });
  const socket = new FakeSocket();

  await broadcaster.subscribe(socket as never, buildPaneBridgeInstance(threadId), {
    type: "subscribe_pane_output",
    thread_id: threadId
  });
  socket.end();
  await fs.promises.appendFile(logPath, "after-close\n");
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.deepEqual(parseSocketMessages(socket), []);

  broadcaster.close();
  await fs.promises.rm(logDir, { recursive: true, force: true });
});
