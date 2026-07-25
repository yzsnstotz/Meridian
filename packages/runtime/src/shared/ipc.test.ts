import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { sendIpcMessage, sendIpcRequest } from "./ipc";

interface TestIpcServer {
  socketPath: string;
  close: () => Promise<void>;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function createIpcServer(
  onPayload: (raw: string, socket: net.Socket) => void
): Promise<TestIpcServer> {
  const tempDir = mkdtempSync(path.join(tmpdir(), "ipc-test-"));
  const socketPath = path.join(tempDir, "hub.sock");
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding("utf8");
    socket.on("error", () => {
      // Client may close immediately after sendIpcMessage flushes payload.
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
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

test("sendIpcMessage resolves after write even when server response closes later", async () => {
  const server = await createIpcServer((raw, socket) => {
    assert.equal(JSON.parse(raw).intent, "list");
    setTimeout(() => {
      if (socket.writable) {
        socket.end(JSON.stringify({ ok: true }));
      }
    }, 400);
  });

  try {
    await Promise.race([
      sendIpcMessage(server.socketPath, { intent: "list", target: "all" }),
      wait(200).then(() => {
        assert.fail("sendIpcMessage did not resolve quickly");
      })
    ]);
  } finally {
    await server.close();
  }
});

test("sendIpcRequest returns parsed response payload", async () => {
  const server = await createIpcServer((raw, socket) => {
    const parsed = JSON.parse(raw) as { intent: string };
    socket.end(JSON.stringify({ status: "success", content: parsed.intent }));
  });

  try {
    const response = await sendIpcRequest<{ intent: string }, { status: string; content: string }>(
      server.socketPath,
      { intent: "list" }
    );
    assert.equal(response.status, "success");
    assert.equal(response.content, "list");
  } finally {
    await server.close();
  }
});
