import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { HubMessage } from "../types";

process.env.TELEGRAM_BOT_TOKEN ??= "123456789:test_token";
process.env.ALLOWED_USER_IDS ??= "123456789";
process.env.MERIDIAN_DISABLE_WEB_AUTOSTART = "true";

const webServerModulePromise = import("./server");

async function createStaticDir(): Promise<string> {
  const staticDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-web-static-"));
  await fs.promises.writeFile(path.join(staticDir, "index.html"), "<!doctype html><title>Meridian</title>");
  return staticDir;
}

async function withServer(
  callback: (context: { baseUrl: string }) => Promise<void>,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const { WebInterfaceServer } = await webServerModulePromise;
  const staticDir = await createStaticDir();
  const server = new WebInterfaceServer({
    enabled: true,
    port: 0,
    listenHost: "127.0.0.1",
    token: "secret-token",
    staticDir,
    ...overrides
  });

  try {
    await server.start();
    const address = server.address();
    assert.ok(address);
    await callback({
      baseUrl: `http://127.0.0.1:${address.port}`
    });
  } finally {
    await server.stop();
    await fs.promises.rm(staticDir, { recursive: true, force: true });
  }
}

test("Web Interface Server rejects unauthenticated requests", async () => {
  let hubCallCount = 0;

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/instances`);
    assert.equal(response.status, 401);
    assert.match(await response.text(), /access token/i);
  }, {
    requestHub: async () => {
      hubCallCount += 1;
      throw new Error("requestHub should not be called");
    }
  });

  assert.equal(hubCallCount, 0);
});

test("Web Interface Server returns instance JSON for an authorized request", async () => {
  const seenMessages: Array<Record<string, unknown>> = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/instances?token=secret-token`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as Array<{ thread_id: string }>;
    assert.deepEqual(payload, [
      {
        thread_id: "codex_01",
        mode: "pane_bridge",
        status: "running"
      }
    ]);
  }, {
    requestHub: async (message: HubMessage) => {
      seenMessages.push(message as unknown as Record<string, unknown>);
      return {
        trace_id: message.trace_id,
        thread_id: "global",
        source: "codex",
        status: "success",
        content: JSON.stringify([
          {
            thread_id: "codex_01",
            mode: "pane_bridge",
            status: "running"
          }
        ]),
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0]?.intent, "list");
  assert.equal(seenMessages[0]?.thread_id, "global");
  assert.equal(seenMessages[0]?.target, "all");
  assert.equal(seenMessages[0]?.suppress_reply, true);
  assert.match(String((seenMessages[0]?.reply_channel as { chat_id?: string }).chat_id), /^web:/);
});

test("Web Interface Server bridges pane output over WebSocket", async () => {
  const socketDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-web-ipc-"));
  const socketPath = path.join(socketDir, "hub.sock");

  const hubServer = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk;
      const frames = buffer.split("\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const payload = frame.trim();
        if (!payload) {
          continue;
        }
        const parsed = JSON.parse(payload) as { type: string; thread_id: string };
        if (parsed.type === "subscribe_pane_output") {
          socket.write(
            `${JSON.stringify({
              type: "pane_output",
              thread_id: parsed.thread_id,
              chunk: "line 1\n",
              timestamp: new Date().toISOString()
            })}\n`
          );
        }
      }
    });
  });

  await new Promise<void>((resolve) => hubServer.listen(socketPath, resolve));

  try {
    await withServer(async ({ baseUrl }) => {
      const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws/terminal?thread_id=codex_01&token=secret-token`);
      const payload = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket payload")), 2000);

        ws.addEventListener("message", (event) => {
          clearTimeout(timeout);
          resolve(String(event.data));
        });
        ws.addEventListener("error", () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket failed"));
        });
      });

      const parsed = JSON.parse(payload) as { type: string; thread_id: string; chunk: string; timestamp: string };
      assert.deepEqual(parsed, {
        type: "pane_output",
        thread_id: "codex_01",
        chunk: "line 1\n",
        timestamp: parsed.timestamp
      });
      await new Promise<void>((resolve) => {
        ws.addEventListener("close", () => resolve(), { once: true });
        ws.close();
      });
    }, {
      hubSocketPath: socketPath
    });
  } finally {
    hubServer.close();
    await fs.promises.rm(socketDir, { recursive: true, force: true });
  }
});
