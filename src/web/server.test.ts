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

test("Web Interface Server lists files from instance working directory", async () => {
  const repoDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-web-files-"));
  await fs.promises.mkdir(path.join(repoDir, "src"), { recursive: true });
  await fs.promises.mkdir(path.join(repoDir, ".git"), { recursive: true });
  await fs.promises.writeFile(path.join(repoDir, "README.md"), "# demo\n");
  await fs.promises.writeFile(path.join(repoDir, "src", "main.ts"), "console.log('ok');\n");
  await fs.promises.writeFile(path.join(repoDir, ".git", "config"), "hidden");

  try {
    await withServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/files?thread_id=codex_01&token=secret-token`);
      assert.equal(response.status, 200);
      const payload = (await response.json()) as Array<{ path: string; kind: string }>;
      assert.ok(payload.some((entry) => entry.path === "README.md" && entry.kind === "file"));
      assert.ok(payload.some((entry) => entry.path === "src/main.ts" && entry.kind === "file"));
      assert.ok(!payload.some((entry) => entry.path.startsWith(".git")));
    }, {
      requestHub: async (message: HubMessage) => {
        if (message.intent !== "list") {
          throw new Error(`Unexpected intent: ${message.intent}`);
        }
        return {
          trace_id: message.trace_id,
          thread_id: "global",
          source: "codex",
          status: "success",
          content: JSON.stringify([
            {
              thread_id: "codex_01",
              mode: "pane_bridge",
              status: "running",
              working_dir: repoDir
            }
          ]),
          attachments: [],
          timestamp: new Date().toISOString()
        };
      }
    });
  } finally {
    await fs.promises.rm(repoDir, { recursive: true, force: true });
  }
});

test("Web Interface Server reads and writes file content in instance working directory", async () => {
  const repoDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-web-edit-"));
  await fs.promises.mkdir(path.join(repoDir, "src"), { recursive: true });
  await fs.promises.writeFile(path.join(repoDir, "src", "main.ts"), "export const v = 1;\n");

  try {
    await withServer(async ({ baseUrl }) => {
      const readResponse = await fetch(
        `${baseUrl}/api/file?thread_id=codex_01&path=${encodeURIComponent("src/main.ts")}&token=secret-token`
      );
      assert.equal(readResponse.status, 200);
      const readPayload = (await readResponse.json()) as { path: string; content: string };
      assert.equal(readPayload.path, "src/main.ts");
      assert.equal(readPayload.content, "export const v = 1;\n");

      const writeResponse = await fetch(`${baseUrl}/api/file?token=secret-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "codex_01",
          path: "src/main.ts",
          content: "export const v = 2;\n"
        })
      });
      assert.equal(writeResponse.status, 200);
      const updated = await fs.promises.readFile(path.join(repoDir, "src", "main.ts"), "utf8");
      assert.equal(updated, "export const v = 2;\n");
    }, {
      requestHub: async (message: HubMessage) => {
        if (message.intent !== "list") {
          throw new Error(`Unexpected intent: ${message.intent}`);
        }
        return {
          trace_id: message.trace_id,
          thread_id: "global",
          source: "codex",
          status: "success",
          content: JSON.stringify([
            {
              thread_id: "codex_01",
              mode: "pane_bridge",
              status: "running",
              working_dir: repoDir
            }
          ]),
          attachments: [],
          timestamp: new Date().toISOString()
        };
      }
    });
  } finally {
    await fs.promises.rm(repoDir, { recursive: true, force: true });
  }
});

test("Web Interface Server forwards terminal approval actions through terminal_input intent", async () => {
  const seenMessages: Array<Record<string, unknown>> = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/terminal_input?token=secret-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        thread_id: "codex_01",
        content: "allow"
      })
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { status: string; content: string };
    assert.equal(payload.status, "success");
    assert.match(payload.content, /approval action/i);
  }, {
    requestHub: async (message: HubMessage) => {
      seenMessages.push(message as unknown as Record<string, unknown>);
      return {
        trace_id: message.trace_id,
        thread_id: "codex_01",
        source: "codex",
        status: "success",
        content: "Sent approval action 'allow' to codex_01.",
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0]?.intent, "terminal_input");
  assert.equal(seenMessages[0]?.thread_id, "codex_01");
  assert.equal(seenMessages[0]?.target, "codex_01");
  assert.equal((seenMessages[0]?.payload as { content?: string })?.content, "allow");
});

test("Web Interface Server returns persisted thread history", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/history?thread_id=codex_01&token=secret-token`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as Array<{
      sequence: number;
      event_kind: string;
      source: string;
      type: string;
      content: string;
      replace_key: string | null;
    }>;
    assert.deepEqual(payload, [
      {
        id: "entry-1",
        sequence: 1,
        event_kind: "user_send",
        source: "user",
        type: "user",
        content: "hello",
        details_text: "",
        trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
        timestamp: "2026-03-09T00:00:00.000Z",
        replace_key: null
      }
    ]);
  }, {
    requestHub: async (message: HubMessage) => {
      assert.equal(message.intent, "history");
      return {
        trace_id: message.trace_id,
        thread_id: "codex_01",
        source: "codex",
        status: "success",
        content: JSON.stringify([
          {
            id: "entry-1",
            sequence: 1,
            event_kind: "user_send",
            source: "user",
            type: "user",
            content: "hello",
            details_text: "",
            trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
            timestamp: "2026-03-09T00:00:00.000Z",
            replace_key: null
          }
        ]),
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });
});

test("Web Interface Server returns authenticated thread progress snapshots", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/progress/codex_01?token=secret-token`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { status: string; content: string; trace_id: string; thread_id: string };
    assert.equal(payload.status, "partial");
    assert.equal(payload.thread_id, "codex_01");
    assert.equal(payload.content, "Task is running...");
    assert.equal(payload.trace_id, "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8");
  }, {
    requestHub: async (message: HubMessage) => {
      assert.equal(message.intent, "monitor_manual_update");
      assert.equal(message.thread_id, "codex_01");
      assert.equal(message.target, "codex_01");
      return {
        trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
        thread_id: "codex_01",
        source: "codex",
        status: "partial",
        content: "Task is running...",
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });
});

test("Web Interface Server returns explicit not-found for invalid progress threads", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/progress/missing-thread?token=secret-token`);
    assert.equal(response.status, 404);
    const payload = (await response.json()) as { error: string };
    assert.match(payload.error, /no active agent session/i);
  }, {
    requestHub: async (message: HubMessage) => {
      assert.equal(message.intent, "monitor_manual_update");
      return {
        trace_id: message.trace_id,
        thread_id: "missing-thread",
        source: "codex",
        status: "error",
        content: "No registered agent instance found for thread_id=missing-thread",
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });
});

test("Web Interface Server returns history thread index and model catalog", async () => {
  const seenIntents: string[] = [];
  await withServer(async ({ baseUrl }) => {
    const [historyRes, modelsRes] = await Promise.all([
      fetch(`${baseUrl}/api/history_threads?token=secret-token`),
      fetch(`${baseUrl}/api/models?thread_id=codex_01&token=secret-token`)
    ]);
    assert.equal(historyRes.status, 200);
    assert.equal(modelsRes.status, 200);
    const historyPayload = (await historyRes.json()) as Array<{ thread_id: string }>;
    const modelsPayload = (await modelsRes.json()) as { current_model_id: string; models: Array<{ id: string }> };
    assert.equal(historyPayload[0]?.thread_id, "codex_01");
    assert.equal(modelsPayload.current_model_id, "gpt-5.4");
    assert.equal(modelsPayload.models[0]?.id, "gpt-5.4");
  }, {
    requestHub: async (message: HubMessage) => {
      seenIntents.push(message.intent);
      if (message.intent === "history") {
        return {
          trace_id: message.trace_id,
          thread_id: "global",
          source: "codex",
          status: "success",
          content: JSON.stringify([
            {
              thread_id: "codex_01",
              updated_at: "2026-03-09T00:00:00.000Z",
              preview: "hello",
              active: true,
              status: "running",
              agent_type: "codex",
              model_id: "gpt-5.4"
            }
          ]),
          attachments: [],
          timestamp: new Date().toISOString()
        };
      }
      return {
        trace_id: message.trace_id,
        thread_id: "codex_01",
        source: "codex",
        status: "success",
        content: JSON.stringify({
          thread_id: "codex_01",
          provider: "codex",
          current_model_id: "gpt-5.4",
          models: [
            { id: "gpt-5.4", label: "GPT 5.4" },
            { id: "codex-5.3-max", label: "Codex 5.3 Max" }
          ]
        }),
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });

  assert.deepEqual(seenIntents.sort(), ["history", "list_models"]);
});

test("Web Interface Server falls back to the thread's current model when live catalog lookup fails", async () => {
  const seenIntents: string[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/models?thread_id=codex_01&token=secret-token`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { current_model_id: string; models: Array<{ id: string; label: string }> };
    assert.equal(payload.current_model_id, "gpt-5.4");
    assert.deepEqual(payload.models, [{ id: "gpt-5.4", label: "gpt-5.4" }]);
  }, {
    requestHub: async (message: HubMessage) => {
      seenIntents.push(message.intent);
      if (message.intent === "list_models") {
        return {
          trace_id: message.trace_id,
          thread_id: "codex_01",
          source: "codex",
          status: "error",
          content: "model catalog unavailable",
          attachments: [],
          timestamp: new Date().toISOString()
        };
      }
      if (message.intent === "list") {
        return {
          trace_id: message.trace_id,
          thread_id: "global",
          source: "codex",
          status: "success",
          content: JSON.stringify([
            {
              thread_id: "codex_01",
              agent_type: "codex",
              model_id: "gpt-5.4",
              mode: "bridge",
              status: "idle"
            }
          ]),
          attachments: [],
          timestamp: new Date().toISOString()
        };
      }
      throw new Error(`Unexpected intent: ${message.intent}`);
    }
  });

  assert.deepEqual(seenIntents, ["list_models", "list"]);
});

test("Web Interface Server switches model through dedicated API", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/models?token=secret-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: "codex_01", model_id: "codex-5.3-max" })
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { content: string; thread_id: string };
    assert.equal(payload.thread_id, "codex_01");
    assert.equal(payload.content, "Switched codex_01 to model=codex-5.3-max");
  }, {
    requestHub: async (message: HubMessage) => {
      assert.equal(message.intent, "switch_model");
      assert.equal(message.thread_id, "codex_01");
      assert.equal(message.target, "codex_01");
      assert.equal(message.payload.content, "codex-5.3-max");
      return {
        trace_id: message.trace_id,
        thread_id: "codex_01",
        source: "codex",
        status: "success",
        content: "Switched codex_01 to model=codex-5.3-max",
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });
});

test("Web Interface Server bridges pane output over WebSocket", async () => {
  const socketDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-web-ipc-"));
  const socketPath = path.join(socketDir, "hub.sock");
  const subscribeRequests: Array<{ replay_lines?: number }> = [];

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
        const parsed = JSON.parse(payload) as { type: string; thread_id: string; replay_lines?: number };
        if (parsed.type === "subscribe_pane_output") {
          subscribeRequests.push({ replay_lines: parsed.replay_lines });
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
    assert.equal(subscribeRequests.length, 1);
    assert.equal(subscribeRequests[0]?.replay_lines, 200);
  } finally {
    hubServer.close();
    await fs.promises.rm(socketDir, { recursive: true, force: true });
  }
});

test("WebSocket pane bridge accepts replay_lines override from query", async () => {
  const socketDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-web-ipc-replay-"));
  const socketPath = path.join(socketDir, "hub.sock");
  const subscribeRequests: Array<{ replay_lines?: number }> = [];

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
        const parsed = JSON.parse(payload) as { type: string; thread_id: string; replay_lines?: number };
        if (parsed.type === "subscribe_pane_output") {
          subscribeRequests.push({ replay_lines: parsed.replay_lines });
          socket.write(
            `${JSON.stringify({
              type: "pane_output",
              thread_id: parsed.thread_id,
              chunk: "",
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
      const ws = new WebSocket(
        `${baseUrl.replace("http://", "ws://")}/ws/terminal?thread_id=codex_01&token=secret-token&replay_lines=0`
      );
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket payload")), 2000);
        ws.addEventListener("message", () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.addEventListener("error", () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket failed"));
        });
      });
      await new Promise<void>((resolve) => {
        ws.addEventListener("close", () => resolve(), { once: true });
        ws.close();
      });
    }, {
      hubSocketPath: socketPath
    });
    assert.equal(subscribeRequests.length, 1);
    assert.equal(subscribeRequests[0]?.replay_lines, 0);
  } finally {
    hubServer.close();
    await fs.promises.rm(socketDir, { recursive: true, force: true });
  }
});
