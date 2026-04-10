import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { HubMessage } from "../../types";
import { FileRelayWatcher, resolveRelayDir, sendViaFileRelay } from "../file-relay";

const tempDirectories = new Set<string>();
const closeables = new Set<{ close(): Promise<void> }>();
const originalRelayDir = process.env.MERIDIAN_FILE_RELAY_DIR;
const originalHubSocketPath = process.env.HUB_SOCKET_PATH;

afterEach(async () => {
  if (originalRelayDir === undefined) {
    delete process.env.MERIDIAN_FILE_RELAY_DIR;
  } else {
    process.env.MERIDIAN_FILE_RELAY_DIR = originalRelayDir;
  }

  if (originalHubSocketPath === undefined) {
    delete process.env.HUB_SOCKET_PATH;
  } else {
    process.env.HUB_SOCKET_PATH = originalHubSocketPath;
  }

  await Promise.all(Array.from(closeables, (entry) => entry.close().catch(() => undefined)));
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));

  closeables.clear();
  tempDirectories.clear();
});

describe("resolveRelayDir", () => {
  it("honors MERIDIAN_FILE_RELAY_DIR when provided", () => {
    process.env.MERIDIAN_FILE_RELAY_DIR = "/tmp/custom-relay";

    expect(resolveRelayDir()).toBe("/tmp/custom-relay");
  });

  it("derives a shared temp relay directory from the hub socket path", () => {
    delete process.env.MERIDIAN_FILE_RELAY_DIR;
    process.env.HUB_SOCKET_PATH = "/tmp/hub-socks/hub-a.sock";
    const relayDirA = resolveRelayDir();

    process.env.HUB_SOCKET_PATH = "/tmp/hub-socks/hub-b.sock";
    const relayDirB = resolveRelayDir();

    expect(path.dirname(relayDirA)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(relayDirA)).toMatch(/^hub-relay-[0-9a-f]{12}$/);
    expect(relayDirA).not.toBe(relayDirB);
  });
});

describe("sendViaFileRelay", () => {
  it("surfaces timeout diagnostics after the request file is written", async () => {
    const relayDir = await createTempDirectory();
    process.env.MERIDIAN_FILE_RELAY_DIR = relayDir;

    const message = buildHubMessage();
    const error = await sendViaFileRelay(message, 50).then(
      () => null,
      (caughtError) => caughtError as Error
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(`File relay response timed out for trace_id=${message.trace_id}`);
    expect(error?.message).toContain(`trace_id=${message.trace_id}`);
    expect(error?.message).toContain("transport=file-relay");
    expect(error?.message).toContain("request_delivery=request-may-have-reached-hub");
    expect(error?.message).toContain("response_path_failure=timeout");
  });

  it("preserves trace_id and reply-path details when hub closes without a body", async () => {
    const relayDir = await createTempDirectory();
    const hubSocketPath = path.join(relayDir, "hub.sock");
    process.env.MERIDIAN_FILE_RELAY_DIR = relayDir;
    process.env.HUB_SOCKET_PATH = hubSocketPath;

    const hub = await startHubServer(hubSocketPath, { responseMode: "empty" });
    closeables.add(hub);

    const watcher = new FileRelayWatcher({ relayDir, hubSocketPath });
    closeables.add({
      async close(): Promise<void> {
        watcher.stop();
      }
    });
    await watcher.start();

    const message = buildHubMessage();
    const result = await sendViaFileRelay(message, 1_000);

    expect(result.status).toBe("error");
    expect(result.trace_id).toBe(message.trace_id);
    expect(result.content).toContain("File relay hub request completed without a response body");
    expect(result.content).toContain(`trace_id=${message.trace_id}`);
    expect(result.content).toContain("transport=file-relay");
    expect(result.content).toContain("request_delivery=request-may-have-reached-hub");
    expect(result.content).toContain("response_path_failure=empty-body");
  });
});

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-roles-file-relay-"));
  tempDirectories.add(directory);
  return directory;
}

async function startHubServer(
  socketPath: string,
  options: { responseMode: "success" | "empty" }
): Promise<{ close(): Promise<void> }> {
  let closed = false;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding("utf8");
    let raw = "";

    socket.on("data", (chunk: string) => {
      raw += chunk;
    });

    socket.once("end", () => {
      const message = JSON.parse(raw) as Partial<HubMessage>;
      if (options.responseMode === "empty") {
        socket.end();
        return;
      }

      socket.end(JSON.stringify({
        trace_id: typeof message.trace_id === "string" ? message.trace_id : randomUUID(),
        thread_id: typeof message.thread_id === "string" ? message.thread_id : "dispatcher-1",
        source: "codex",
        status: "success",
        content: "ok",
        attachments: [],
        timestamp: new Date().toISOString()
      }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    async close(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await fs.rm(socketPath, { force: true }).catch(() => undefined);
    }
  };
}

function buildHubMessage(overrides: Partial<HubMessage> = {}): Partial<HubMessage> {
  return {
    trace_id: randomUUID(),
    thread_id: "dispatcher-1",
    actor_id: "service:meridian-roles",
    intent: "run",
    target: "codex_01",
    priority: 5,
    mode: "bridge",
    payload: {
      content: "Run the worker",
      attachments: []
    },
    reply_channel: {
      channel: "web",
      chat_id: "service:meridian-roles"
    },
    ...overrides
  };
}
