import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Socket } from "node:net";

import { ProviderCapabilityListSchema, ProviderCapabilitySchema, type HubMessage, type ThreadProgressSnapshot } from "../types";

process.env.TELEGRAM_BOT_TOKEN ??= "123456789:test_token";
process.env.ALLOWED_USER_IDS ??= "123456789";
process.env.MERIDIAN_DISABLE_WEB_AUTOSTART = "true";

const webServerModulePromise = import("./server");
const { config } = require("../config") as typeof import("../config");

class FakeHubSocket extends Duplex {
  written = "";

  _read(): void {}

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.written += chunk.toString();
    callback();
  }

  pushLine(line: string): void {
    this.push(`${line}\n`);
  }
}

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
    const payload = (await response.json()) as Array<{
      thread_id: string;
      mode: string;
      status: string;
      agent_type: string;
      model_id: string;
    }>;
    assert.deepEqual(payload, [
      {
        thread_id: "codex_01",
        mode: "bridge",
        status: "running",
        agent_type: "codex",
        model_id: "gpt-5.4"
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
            mode: "bridge",
            status: "running",
            agent_type: "codex",
            model_id: "gpt-5.4"
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

test("Web Interface Server returns log inventory for an authorized request", async () => {
  const logDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-web-logs-"));

  try {
    await fs.promises.mkdir(path.join(logDir, "GUI"), { recursive: true });
    await fs.promises.writeFile(path.join(logDir, "hub.log"), "1234567890");
    await fs.promises.writeFile(path.join(logDir, "GUI", "gui-pane-codex_01.log"), "1234");

    await withServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/logs?token=secret-token`);
      assert.equal(response.status, 200);
      const payload = (await response.json()) as {
        root: string;
        total_bytes: number;
        files: Array<{ path: string; size_bytes: number; category: string }>;
      };
      assert.equal(payload.root, logDir);
      assert.equal(payload.total_bytes, 14);
      assert.deepEqual(
        payload.files.map((entry) => entry.path),
        ["hub.log", "GUI/gui-pane-codex_01.log"]
      );
      assert.deepEqual(
        payload.files.map((entry) => entry.category),
        ["active", "session"]
      );
    }, {
      logDir
    });
  } finally {
    await fs.promises.rm(logDir, { recursive: true, force: true });
  }
});

test("Web Interface Server returns log file contents for an authorized request", async () => {
  const logDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-web-logfile-"));

  try {
    await fs.promises.writeFile(path.join(logDir, "hub.log"), "line1\nline2\n");

    await withServer(async ({ baseUrl }) => {
      const response = await fetch(
        `${baseUrl}/api/log_file?token=secret-token&path=${encodeURIComponent("hub.log")}`
      );
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { path: string; content: string; truncated: boolean };
      assert.equal(payload.path, "hub.log");
      assert.equal(payload.content, "line1\nline2\n");
      assert.equal(payload.truncated, false);
    }, {
      logDir
    });
  } finally {
    await fs.promises.rm(logDir, { recursive: true, force: true });
  }
});

test("Web Interface Server streams A2A terminal events with replay", async () => {
  const logDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-web-a2a-stream-"));
  const hubSocket = new FakeHubSocket();
  const replayLine = JSON.stringify({
    type: "a2a_message",
    taskId: "trace-replay",
    taskState: "working",
    parts: [{ type: "text", text: "replayed" }]
  });
  const liveLine = JSON.stringify({
    type: "a2a_message",
    taskId: "trace-live",
    taskState: "completed",
    parts: [{ type: "text", text: "live" }]
  });

  try {
    await fs.promises.mkdir(path.join(logDir, "GUI"), { recursive: true });
    await fs.promises.writeFile(
      path.join(logDir, "GUI", "a2a-codex_01.log"),
      `${JSON.stringify({ type: "a2a_message", taskId: "older", taskState: "working", parts: [] })}\n${replayLine}\n`
    );

    await withServer(async ({ baseUrl }) => {
      const controller = new AbortController();
      const response = await fetch(
        `${baseUrl}/api/a2a_stream?thread_id=codex_01&replay_lines=1&token=secret-token`,
        { signal: controller.signal }
      );
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
      assert.match(hubSocket.written, /"type":"a2a_stream_subscribe"/);
      assert.match(hubSocket.written, /"thread_id":"codex_01"/);

      const reader = response.body?.getReader();
      assert.ok(reader);
      const decoder = new TextDecoder();
      let observed = "";
      while (!observed.includes("replayed")) {
        const next = await reader.read();
        assert.equal(next.done, false);
        observed += decoder.decode(next.value, { stream: true });
      }

      hubSocket.pushLine(liveLine);
      while (!observed.includes("live")) {
        const next = await reader.read();
        assert.equal(next.done, false);
        observed += decoder.decode(next.value, { stream: true });
      }

      controller.abort();
      assert.match(observed, new RegExp(`data: ${replayLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(observed, new RegExp(`data: ${liveLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }, {
      logDir,
      hubSocketFactory: () => hubSocket as unknown as Socket
    });
  } finally {
    hubSocket.destroy();
    await fs.promises.rm(logDir, { recursive: true, force: true });
  }
});

test("Web Interface Server clears a log file for an authorized POST", async () => {
  const logDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-web-logclear-"));

  try {
    await fs.promises.writeFile(path.join(logDir, "hub.log"), "line1\nline2\n");

    await withServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/log_file/clear?token=secret-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "hub.log" })
      });
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { ok: boolean; path: string };
      assert.equal(payload.ok, true);
      assert.equal(payload.path, "hub.log");
      const after = await fs.promises.readFile(path.join(logDir, "hub.log"), "utf8");
      assert.equal(after, "");
    }, {
      logDir
    });
  } finally {
    await fs.promises.rm(logDir, { recursive: true, force: true });
  }
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
              mode: "bridge",
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
              mode: "bridge",
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

test("Web Interface Server forwards interrupt requests through interrupt intent", async () => {
  const seenMessages: Array<Record<string, unknown>> = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/interrupt?token=secret-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        thread_id: "codex_01"
      })
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { status: string; content: string };
    assert.equal(payload.status, "success");
    assert.match(payload.content, /interrupted/i);
  }, {
    requestHub: async (message: HubMessage) => {
      seenMessages.push(message as unknown as Record<string, unknown>);
      return {
        trace_id: message.trace_id,
        thread_id: "codex_01",
        source: "codex",
        status: "success",
        content: "Agent instance codex_01 interrupted",
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0]?.intent, "interrupt");
  assert.equal(seenMessages[0]?.thread_id, "codex_01");
  assert.equal(seenMessages[0]?.target, "codex_01");
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

test("Web Interface Server compacts thread history when bootstrap limits are requested", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(
      `${baseUrl}/api/history?thread_id=codex_01&limit=2&max_content_chars=24&max_detail_chars=24&max_raw_chars=18&token=secret-token`
    );
    assert.equal(response.status, 200);
    const payload = (await response.json()) as Array<{
      id: string;
      content: string;
      details_text: string;
      raw_content: string;
    }>;

    assert.equal(payload.length, 2);
    assert.deepEqual(
      payload.map((entry) => entry.id),
      ["entry-2", "entry-3"]
    );
    assert.match(payload[1]?.content ?? "", /\[History truncated\]/);
    assert.match(payload[1]?.details_text ?? "", /\[History truncated\]/);
    assert.match(payload[1]?.raw_content ?? "", /^\[History truncated/);
    assert.ok((payload[1]?.content ?? "").length <= 24);
    assert.ok((payload[1]?.details_text ?? "").length <= 24);
    assert.ok((payload[1]?.raw_content ?? "").length <= 18);
  }, {
    requestHub: async (message: HubMessage) => {
      assert.equal(message.intent, "history");
      assert.equal(message.payload.history_limit, 2);
      assert.equal(message.payload.history_max_content_chars, 24);
      assert.equal(message.payload.history_max_detail_chars, 24);
      assert.equal(message.payload.history_max_raw_chars, 18);
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
            content: "older",
            details_text: "",
            raw_content: "",
            trace_id: "11111111-1111-4111-8111-111111111111",
            timestamp: "2026-03-09T00:00:00.000Z",
            replace_key: null
          },
          {
            id: "entry-2",
            sequence: 2,
            event_kind: "user_send",
            source: "user",
            type: "user",
            content: "recent",
            details_text: "",
            raw_content: "",
            trace_id: "22222222-2222-4222-8222-222222222222",
            timestamp: "2026-03-09T00:01:00.000Z",
            replace_key: null
          },
          {
            id: "entry-3",
            sequence: 3,
            event_kind: "final_reply",
            source: "codex",
            type: "agent",
            content: "done\n" + "x".repeat(40),
            details_text: "012345678901234567890123456789",
            raw_content: "abcdefghijklmnopqrstuvwxyz",
            trace_id: "33333333-3333-4333-8333-333333333333",
            timestamp: "2026-03-09T00:02:00.000Z",
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
    const payload = (await response.json()) as ThreadProgressSnapshot;
    assert.equal(payload.status, "partial");
    assert.equal(payload.thread_id, "codex_01");
    assert.equal(payload.content, "Task is running...");
    assert.equal(payload.trace_id, "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8");
    assert.equal(payload.display_text, "Task is running...");
    assert.equal(payload.event_kind, "progress");
    assert.equal(payload.phase, "running");
    assert.equal(payload.waiting_for_input, false);
    assert.match(payload.updated_at, /T/);
  }, {
    requestHub: async (message: HubMessage) => {
      assert.equal(message.intent, "monitor_manual_update");
      assert.equal(message.thread_id, "codex_01");
      assert.equal(message.target, "codex_01");
      const updatedAt = new Date().toISOString();
      return {
        trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
        thread_id: "codex_01",
        source: "codex",
        status: "partial",
        content: "Task is running...",
        progress: {
          trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
          thread_id: "codex_01",
          source: "codex",
          status: "partial",
          event_kind: "progress",
          phase: "running",
          waiting_for_input: false,
          content: "Task is running...",
          display_text: "Task is running...",
          updated_at: updatedAt
        },
        attachments: [],
        timestamp: updatedAt
      };
    }
  });
});

test("Web Interface Server derives structured progress snapshots from legacy partial results", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/progress/codex_01?token=secret-token`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as ThreadProgressSnapshot;
    assert.equal(payload.phase, "waiting_for_input");
    assert.equal(payload.event_kind, "approval");
    assert.equal(payload.waiting_for_input, true);
    assert.match(payload.content, /^Waiting for approval\.\.\./);
  }, {
    requestHub: async (message: HubMessage) => {
      assert.equal(message.intent, "monitor_manual_update");
      return {
        trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
        thread_id: "codex_01",
        source: "codex",
        status: "partial",
        content: "Waiting for approval...\nRun this command?\n1. Allow once",
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

test("Web Interface Server records run usage meters for scoped queries", async () => {
  const logDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-web-usage-"));
  let jobId = "";

  try {
    await withServer(async ({ baseUrl }) => {
      const runResponse = await fetch(`${baseUrl}/api/run?token=secret-token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-email-loop-tenant-id": "tenant-email-loop-test"
        },
        body: JSON.stringify({
          thread_id: "codex_01",
          content: JSON.stringify({
            tenantId: "tenant-from-prompt",
            roleType: "mail-manager",
            mailboxId: "mailbox-nobuaki"
          })
        })
      });
      assert.equal(runResponse.status, 200);
      const runPayload = (await runResponse.json()) as { trace_id: string };
      jobId = runPayload.trace_id;

      const tenantResponse = await fetch(
        `${baseUrl}/api/usage?token=secret-token&kind=tenant&id=tenant-email-loop-test`
      );
      assert.equal(tenantResponse.status, 200);
      const tenantPayload = (await tenantResponse.json()) as {
        usage: {
          meters: Array<Record<string, unknown>>;
          total: Record<string, unknown>;
        };
      };
      assert.equal(tenantPayload.usage.meters.length, 1);
      assert.equal(tenantPayload.usage.total.totalTokens, 230);
      assert.equal(tenantPayload.usage.total.inputTokens, 100);
      assert.equal(tenantPayload.usage.total.cachedInputTokens, 40);
      assert.equal(tenantPayload.usage.total.outputTokens, 80);
      assert.equal(tenantPayload.usage.total.reasoningTokens, 10);

      const meter = tenantPayload.usage.meters[0];
      assert.equal(meter?.tenantId, "tenant-email-loop-test");
      assert.equal(meter?.provider, "codex");
      assert.equal(meter?.model, "gpt-5.5");
      assert.equal(meter?.credentialId, "cred-nobuaki");
      assert.equal(meter?.roleId, "mail-manager");
      assert.equal(meter?.mailboxId, "mailbox-nobuaki");

      const [jobResponse, providerResponse, modelResponse] = await Promise.all([
        fetch(`${baseUrl}/api/usage?token=secret-token&kind=job&id=${jobId}`),
        fetch(`${baseUrl}/api/usage?token=secret-token&kind=provider&id=codex`),
        fetch(`${baseUrl}/api/usage?token=secret-token&kind=model&id=${encodeURIComponent("gpt-5.5")}`)
      ]);
      assert.equal(jobResponse.status, 200);
      assert.equal(providerResponse.status, 200);
      assert.equal(modelResponse.status, 200);
      assert.equal(((await jobResponse.json()) as { usage: { total: { totalTokens: number } } }).usage.total.totalTokens, 230);
      assert.equal(
        ((await providerResponse.json()) as { usage: { total: { totalTokens: number } } }).usage.total.totalTokens,
        230
      );
      assert.equal(((await modelResponse.json()) as { usage: { total: { totalTokens: number } } }).usage.total.totalTokens, 230);
    }, {
      logDir,
      requestHubRun: async (message: HubMessage) => {
        assert.equal(message.intent, "run");
        return {
          trace_id: message.trace_id,
          thread_id: "codex_01",
          source: "codex",
          model_id: "gpt-5.5",
          credential_id: "cred-nobuaki",
          status: "success",
          content: "done",
          usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 80,
            reasoning_output_tokens: 10,
            total_tokens: 230
          },
          attachments: [],
          timestamp: new Date().toISOString()
        };
      }
    });
  } finally {
    await fs.promises.rm(logDir, { recursive: true, force: true });
  }
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

test("Web Interface Server lists selectable models for a provider before spawn", async () => {
  const seenIntents: string[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/models?provider=claude&token=secret-token`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      provider: string;
      current_model_id: null;
      models: Array<{ id: string; label: string }>;
    };
    assert.equal(payload.provider, "claude");
    assert.equal(payload.current_model_id, null);
    assert.deepEqual(payload.models, [
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-6", label: "Claude Opus 4.6" }
    ]);
  }, {
    requestHub: async (message: HubMessage) => {
      seenIntents.push(message.intent);
      throw new Error(`Unexpected intent: ${message.intent}`);
    },
    providerModelCatalog: {
      listModels: async () => ({
        provider: "claude" as const,
        models: [
          { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
          { id: "claude-opus-4-6", label: "Claude Opus 4.6" }
        ]
      })
    }
  });

  assert.deepEqual(seenIntents, []);
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

test("Web Interface Server lists all provider capabilities without hub calls", async () => {
  const seenIntents: string[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/capabilities?token=secret-token`);
    assert.equal(response.status, 200);
    const payload = ProviderCapabilityListSchema.parse(await response.json());
    assert.deepEqual(
      payload.map((entry) => entry.agent_type),
      ["codex", "claude", "gemini"]
    );
    assert.equal(payload[0]?.supports_read_only, true);
    assert.equal(payload[2]?.supports_ads_safe, false);
  }, {
    requestHub: async (message: HubMessage) => {
      seenIntents.push(message.intent);
      throw new Error(`Unexpected intent: ${message.intent}`);
    }
  });

  assert.deepEqual(seenIntents, []);
});

test("Web Interface Server filters provider capabilities by type", async () => {
  const seenIntents: string[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/capabilities?type=codex&token=secret-token`);
    assert.equal(response.status, 200);
    const payload = ProviderCapabilitySchema.parse(await response.json());
    assert.equal(payload.agent_type, "codex");
    assert.equal(payload.supports_images, false);
    assert.equal(payload.supports_read_only, true);
  }, {
    requestHub: async (message: HubMessage) => {
      seenIntents.push(message.intent);
      throw new Error(`Unexpected intent: ${message.intent}`);
    }
  });

  assert.deepEqual(seenIntents, []);
});

test("Web Interface Server returns not found for provider capabilities that are not configured", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/capabilities?type=cursor&token=secret-token`);
    assert.equal(response.status, 404);
    const payload = (await response.json()) as { error: string };
    assert.match(payload.error, /No provider capabilities configured for agent_type=cursor/);
  }, {
    requestHub: async (message: HubMessage) => {
      throw new Error(`Unexpected intent: ${message.intent}`);
    }
  });
});

test("Web Interface Server lists spawn repo choices under AGENT_WORKDIR", async () => {
  const subDir = path.join(config.AGENT_WORKDIR, `meridian-web-spawn-list-${Date.now()}`);
  await fs.promises.mkdir(subDir, { recursive: true });
  try {
    await withServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/spawn_repos?token=secret-token`);
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { root: string; repos: Array<{ name: string }> };
      assert.equal(payload.root, path.resolve(config.AGENT_WORKDIR));
      assert.ok(payload.repos.some((r) => r.name === path.basename(subDir)));
    });
  } finally {
    await fs.promises.rm(subDir, { recursive: true, force: true });
  }
});

test("Web Interface Server forwards resolved spawn_dir to Hub when repo is selected", async () => {
  const subDir = path.join(config.AGENT_WORKDIR, `meridian-web-spawn-repo-${Date.now()}`);
  await fs.promises.mkdir(subDir, { recursive: true });
  const hubMessages: HubMessage[] = [];
  try {
    await withServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/spawn?token=secret-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "codex",
          mode: "bridge",
          repo: path.basename(subDir)
        })
      });
      assert.equal(response.status, 200);
      assert.equal(hubMessages.length, 1);
      assert.equal(hubMessages[0]?.intent, "spawn");
      assert.equal(hubMessages[0]?.payload.spawn_dir, subDir);
    }, {
      requestHub: async (message: HubMessage) => {
        hubMessages.push(message);
        return {
          trace_id: message.trace_id,
          thread_id: "codex_new",
          source: "codex",
          status: "success",
          content: "{}",
          attachments: [],
          timestamp: new Date().toISOString()
        };
      }
    });
  } finally {
    await fs.promises.rm(subDir, { recursive: true, force: true });
  }
});

test("Web Interface Server forwards absolute repo path to Hub", async () => {
  const externalDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-web-absolute-repo-"));
  const hubMessages: HubMessage[] = [];
  try {
    await withServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/spawn?token=secret-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "codex",
          mode: "bridge",
          repo: externalDir
        })
      });
      assert.equal(response.status, 200);
      assert.equal(hubMessages[0]?.payload.spawn_dir, externalDir);
    }, {
      requestHub: async (message: HubMessage) => {
        hubMessages.push(message);
        return {
          trace_id: message.trace_id,
          thread_id: "codex_new",
          source: "codex",
          status: "success",
          content: "{}",
          attachments: [],
          timestamp: new Date().toISOString()
        };
      }
    });
  } finally {
    await fs.promises.rm(externalDir, { recursive: true, force: true });
  }
});

test("Web Interface Server spawn forwards provider alias, model_id, effort, and default auto_approve", async () => {
  const hubMessages: HubMessage[] = [];
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/spawn?token=secret-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "claude",
        mode: "bridge",
        model_id: "claude-opus-4-6",
        effort: "xhigh"
      })
    });
    assert.equal(response.status, 200);
    assert.equal(hubMessages.length, 1);
    assert.equal(hubMessages[0]?.intent, "spawn");
    assert.equal(hubMessages[0]?.target, "claude");
    assert.equal(hubMessages[0]?.payload.model_id, "claude-opus-4-6");
    assert.equal(hubMessages[0]?.payload.effort, "xhigh");
    assert.equal(hubMessages[0]?.payload.auto_approve, true);
  }, {
    requestHub: async (message: HubMessage) => {
      hubMessages.push(message);
      return {
        trace_id: message.trace_id,
        thread_id: "claude_new",
        source: "claude",
        status: "success",
        content: "{}",
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });
});

test("Web Interface Server accepts stateless_call spawn mode", async () => {
  const hubMessages: HubMessage[] = [];
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/spawn?token=secret-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "codex",
        mode: "stateless_call",
        model_id: "gpt-5.4"
      })
    });
    assert.equal(response.status, 200);
    assert.equal(hubMessages.length, 1);
    assert.equal(hubMessages[0]?.intent, "spawn");
    assert.equal(hubMessages[0]?.target, "codex");
    assert.equal(hubMessages[0]?.mode, "stateless_call");
    assert.equal(hubMessages[0]?.payload.model_id, "gpt-5.4");
  }, {
    requestHub: async (message: HubMessage) => {
      hubMessages.push(message);
      return {
        trace_id: message.trace_id,
        thread_id: "codex_stateless",
        source: "codex",
        status: "success",
        content: "{}",
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });
});

test("Web Interface Server enforces ADS profile spawn safety defaults", async () => {
  const hubMessages: HubMessage[] = [];
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/spawn?token=secret-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "codex",
        mode: "bridge",
        auto_approve: true,
        integration_profile: "ads_public",
        sandbox_mode: "workspace-write"
      })
    });
    assert.equal(response.status, 200);
    assert.equal(hubMessages.length, 1);
    assert.equal(hubMessages[0]?.mode, "stateless_call");
    assert.equal(hubMessages[0]?.payload.auto_approve, false);
    assert.equal(hubMessages[0]?.payload.integration_profile, "ads_public");
    assert.equal(hubMessages[0]?.payload.sandbox_mode, "read-only");
  }, {
    requestHub: async (message: HubMessage) => {
      hubMessages.push(message);
      return {
        trace_id: message.trace_id,
        thread_id: "codex_ads",
        source: "codex",
        status: "success",
        content: "{}",
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });
});

test("Web Interface Server rejects ADS public stateless spawns for non-Codex providers", async () => {
  const hubMessages: HubMessage[] = [];
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/spawn?token=secret-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "claude",
        integration_profile: "ads_public"
      })
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /ads_public.*codex/i);
    assert.equal(hubMessages.length, 0);
  }, {
    requestHub: async (message: HubMessage) => {
      hubMessages.push(message);
      throw new Error("requestHub should not be called");
    }
  });
});

test("Web Interface Server rejects spawn when repo and spawn_dir are both set", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/spawn?token=secret-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "codex",
        repo: "a",
        spawn_dir: "/tmp/b"
      })
    });
    assert.equal(response.status, 400);
  });
});

test("Web Interface Server forwards explicit spawn_dir outside AGENT_WORKDIR", async () => {
  const externalDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-web-explicit-spawn-"));
  const hubMessages: HubMessage[] = [];
  try {
    await withServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/spawn?token=secret-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "codex",
          mode: "bridge",
          spawn_dir: externalDir
        })
      });
      assert.equal(response.status, 200);
      assert.equal(hubMessages[0]?.payload.spawn_dir, externalDir);
    }, {
      requestHub: async (message: HubMessage) => {
        hubMessages.push(message);
        return {
          trace_id: message.trace_id,
          thread_id: "codex_new",
          source: "codex",
          status: "success",
          content: "{}",
          attachments: [],
          timestamp: new Date().toISOString()
        };
      }
    });
  } finally {
    await fs.promises.rm(externalDir, { recursive: true, force: true });
  }
});

test("Web Interface Server browse can navigate above AGENT_WORKDIR", async () => {
  await withServer(async ({ baseUrl }) => {
    const rootResponse = await fetch(`${baseUrl}/api/spawn_repos/browse?token=secret-token`);
    assert.equal(rootResponse.status, 200);
    const rootPayload = await rootResponse.json() as {
      root: string;
      parent_relative: string | null;
    };
    assert.equal(rootPayload.root, path.resolve(config.AGENT_WORKDIR));
    assert.equal(rootPayload.parent_relative, path.dirname(path.resolve(config.AGENT_WORKDIR)));

    const absoluteBrowsePath = path.dirname(path.resolve(config.AGENT_WORKDIR));
    const response = await fetch(
      `${baseUrl}/api/spawn_repos/browse?token=secret-token&relative=${encodeURIComponent(absoluteBrowsePath)}`
    );
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      relative: string;
      parent_relative: string | null;
    };
    assert.equal(payload.relative, absoluteBrowsePath);
    assert.equal(payload.parent_relative, path.dirname(absoluteBrowsePath));
  });
});

test("Web Interface Server spawn_repos browse lists nested directories", async () => {
  const outer = path.join(config.AGENT_WORKDIR, `meridian-browse-outer-${Date.now()}`);
  const inner = path.join(outer, "inner");
  await fs.promises.mkdir(inner, { recursive: true });
  try {
    await withServer(async ({ baseUrl }) => {
      const relOuter = path.basename(outer);
      const response = await fetch(
        `${baseUrl}/api/spawn_repos/browse?token=secret-token&relative=${encodeURIComponent(relOuter)}`
      );
      assert.equal(response.status, 200);
      const payload = (await response.json()) as {
        relative: string;
        parent_relative: string | null;
        entries: Array<{ name: string }>;
      };
      assert.equal(payload.relative, relOuter);
      assert.equal(payload.parent_relative, "");
      assert.ok(payload.entries.some((e) => e.name === "inner"));
    });
  } finally {
    await fs.promises.rm(outer, { recursive: true, force: true });
  }
});

test("Web Interface Server spawn_repos browse rejects path traversal", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(
      `${baseUrl}/api/spawn_repos/browse?token=secret-token&relative=${encodeURIComponent("../..")}`
    );
    assert.equal(response.status, 400);
  });
});

test("Web Interface Server forwards nested repo path to Hub", async () => {
  const outer = path.join(config.AGENT_WORKDIR, `meridian-nested-repo-${Date.now()}`);
  const inner = path.join(outer, "deep");
  await fs.promises.mkdir(inner, { recursive: true });
  const hubMessages: HubMessage[] = [];
  try {
    await withServer(async ({ baseUrl }) => {
      const rel = `${path.basename(outer)}/deep`;
      const response = await fetch(`${baseUrl}/api/spawn?token=secret-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "codex",
          mode: "bridge",
          repo: rel
        })
      });
      assert.equal(response.status, 200);
      assert.equal(hubMessages[0]?.payload.spawn_dir, inner);
    }, {
      requestHub: async (message: HubMessage) => {
        hubMessages.push(message);
        return {
          trace_id: message.trace_id,
          thread_id: "codex_new",
          source: "codex",
          status: "success",
          content: "{}",
          attachments: [],
          timestamp: new Date().toISOString()
        };
      }
    });
  } finally {
    await fs.promises.rm(outer, { recursive: true, force: true });
  }
});


test("Web Interface Server returns health payload for an authorized request", async () => {
  const socketPath = path.join(os.tmpdir(), `meridian-health-${Date.now()}.sock`);
  await fs.promises.writeFile(socketPath, "");

  try {
    await withServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/health?token=secret-token`);
      assert.equal(response.status, 200);
      const payload = (await response.json()) as {
        ok: boolean;
        version: string;
        uptime: number;
        agents_count: number;
      };
      assert.equal(payload.ok, true);
      assert.match(payload.version, /^\d+\.\d+\.\d+/);
      assert.equal(payload.agents_count, 1);
      assert.equal(typeof payload.uptime, "number");
      assert.ok(payload.uptime >= 0);
    }, {
      hubSocketPath: socketPath,
      requestHub: async (message: HubMessage) => {
        assert.equal(message.intent, "list");
        return {
          trace_id: message.trace_id,
          thread_id: "global",
          source: "codex",
          status: "success",
          content: JSON.stringify([
            {
              thread_id: "codex_01",
              mode: "bridge",
              status: "running"
            }
          ]),
          attachments: [],
          timestamp: new Date().toISOString()
        };
      }
    });
  } finally {
    await fs.promises.rm(socketPath, { force: true });
  }
});

test("Web Interface Server POST /api/autoapprove forwards set_auto_approve intent with boolean content", async () => {
  const hubMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/autoapprove?token=secret-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ thread_id: "codex_01", enabled: false })
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { thread_id: string; auto_approve: boolean };
    assert.deepEqual(payload, { thread_id: "codex_01", auto_approve: false });
  }, {
    requestHub: async (message: HubMessage) => {
      hubMessages.push(message);
      return {
        trace_id: message.trace_id,
        thread_id: "codex_01",
        source: "codex",
        status: "success",
        content: "auto_approve=false for thread=codex_01",
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });

  assert.equal(hubMessages.length, 1);
  assert.equal(hubMessages[0]?.intent, "set_auto_approve");
  assert.equal(hubMessages[0]?.thread_id, "codex_01");
  assert.equal(hubMessages[0]?.target, "codex_01");
  assert.equal(hubMessages[0]?.payload.content, "false");
});

test("Web Interface Server POST /api/autoapprove maps enable=true to string content true", async () => {
  const hubMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/autoapprove?token=secret-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ thread_id: "codex_02", enabled: true })
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { thread_id: string; auto_approve: boolean };
    assert.deepEqual(payload, { thread_id: "codex_02", auto_approve: true });
  }, {
    requestHub: async (message: HubMessage) => {
      hubMessages.push(message);
      return {
        trace_id: message.trace_id,
        thread_id: "codex_02",
        source: "codex",
        status: "success",
        content: "auto_approve=true for thread=codex_02",
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });

  assert.equal(hubMessages[0]?.intent, "set_auto_approve");
  assert.equal(hubMessages[0]?.payload.content, "true");
});

test("Web Interface Server POST /api/autoapprove returns 404 when instance not found", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/autoapprove?token=secret-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ thread_id: "missing", enabled: true })
    });
    assert.equal(response.status, 404);
  }, {
    requestHub: async (message: HubMessage) => ({
      trace_id: message.trace_id,
      thread_id: "missing",
      source: "codex",
      status: "error",
      content: "No registered agent instance found for thread=missing",
      attachments: [],
      timestamp: new Date().toISOString()
    })
  });
});

test("Web Interface Server POST /api/autoapprove rejects missing thread_id", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/autoapprove?token=secret-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true })
    });
    assert.equal(response.status, 400);
  });
});

test("Web Interface Server GET /api/autoapprove returns per-thread approval state from list", async () => {
  const hubMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/autoapprove?token=secret-token&thread_id=codex_01`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { thread_id: string; auto_approve: boolean };
    assert.deepEqual(payload, { thread_id: "codex_01", auto_approve: true });
  }, {
    requestHub: async (message: HubMessage) => {
      hubMessages.push(message);
      return {
        trace_id: message.trace_id,
        thread_id: "global",
        source: "codex",
        status: "success",
        content: JSON.stringify([
          {
            thread_id: "codex_01",
            agent_type: "codex",
            status: "running",
            auto_approve: true
          }
        ]),
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });

  assert.equal(hubMessages[0]?.intent, "list");
});

test("Web Interface Server GET /api/autoapprove returns 404 when thread missing from list", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/autoapprove?token=secret-token&thread_id=unknown`);
    assert.equal(response.status, 404);
  }, {
    requestHub: async (message: HubMessage) => ({
      trace_id: message.trace_id,
      thread_id: "global",
      source: "codex",
      status: "success",
      content: JSON.stringify([
        {
          thread_id: "codex_01",
          agent_type: "codex",
          status: "running",
          auto_approve: false
        }
      ]),
      attachments: [],
      timestamp: new Date().toISOString()
    })
  });
});

async function withEnv(
  values: Record<string, string | undefined>,
  callback: () => Promise<void>
): Promise<void> {
  const original = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) {
    original.set(key, process.env[key]);
    const nextValue = values[key];
    if (nextValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = nextValue;
    }
  }
  try {
    await callback();
  } finally {
    for (const [key, value] of original.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("Web Interface Server spawn forwards auto_approve=false without injecting provider flags", async () => {
  const hubMessages: HubMessage[] = [];
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/spawn?token=secret-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "codex",
        mode: "bridge",
        auto_approve: false
      })
    });
    assert.equal(response.status, 200);
    assert.equal(hubMessages.length, 1);
    assert.equal(hubMessages[0]?.intent, "spawn");
    assert.equal(hubMessages[0]?.target, "codex");
    assert.equal(hubMessages[0]?.payload.auto_approve, false);
    // Callers must not ship provider-specific CLI flags; the field stays neutral at the HTTP boundary.
    const payloadKeys = Object.keys((hubMessages[0]?.payload ?? {}) as Record<string, unknown>);
    for (const key of payloadKeys) {
      assert.ok(!key.startsWith("--"), `payload must not carry raw CLI flags: ${key}`);
    }
  }, {
    requestHub: async (message: HubMessage) => {
      hubMessages.push(message);
      return {
        trace_id: message.trace_id,
        thread_id: "codex_new",
        source: "codex",
        status: "success",
        content: "{}",
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });
});

test("GET /api/callers returns caller list signed as meridian-admin with key_hash stripped", async () => {
  const seenMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/callers`, {
      headers: { Authorization: "Bearer secret-token" }
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { callers: Array<Record<string, unknown>>; bootstrap_key_set: boolean };
    assert.equal(typeof payload.bootstrap_key_set, "boolean");
    assert.ok(Array.isArray(payload.callers));
    for (const record of payload.callers) {
      assert.ok(!("key_hash" in record), "key_hash must not appear in list response");
    }
    assert.equal(payload.callers[0]?.caller_id, "meridian-web");
  }, {
    requestAdminHub: async (message: HubMessage) => {
      seenMessages.push(message);
      return {
        trace_id: message.trace_id,
        thread_id: "global",
        source: "codex",
        status: "success",
        content: JSON.stringify({
          callers: [
            { caller_id: "meridian-web", caller_kind: "builtin", caller_label: "Meridian Web", key_hash: "shouldbestripped123" }
          ],
          bootstrap_key_set: true
        }),
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0]?.intent, "list_callers");
  assert.equal((seenMessages[0]?.caller as { caller_id?: string })?.caller_id, "meridian-admin");
});

test("GET /api/callers returns 401 without Bearer token", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/callers`);
    assert.equal(response.status, 401);
  }, {
    requestAdminHub: async () => { throw new Error("requestAdminHub should not be called"); }
  });
});

test("POST /api/callers registers external caller and returns cleartext key", async () => {
  const seenMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/callers`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-token", "content-type": "application/json" },
      body: JSON.stringify({ caller_id: "my-bot", caller_label: "My Bot" })
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { caller_id: string; caller_key: string };
    assert.equal(payload.caller_id, "my-bot");
    assert.equal(typeof payload.caller_key, "string");
    assert.ok(payload.caller_key.length > 0);
  }, {
    requestAdminHub: async (message: HubMessage) => {
      seenMessages.push(message);
      const body = JSON.parse(message.payload.content as string) as Record<string, unknown>;
      assert.equal(body.caller_kind, "external");
      return {
        trace_id: message.trace_id,
        thread_id: "global",
        source: "codex",
        status: "success",
        content: JSON.stringify({ caller_id: "my-bot", caller_key: "cleartext-abc123" }),
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0]?.intent, "register_caller");
  assert.equal((seenMessages[0]?.caller as { caller_id?: string })?.caller_id, "meridian-admin");
});

test("POST /api/callers forwards requested caller authority", async () => {
  const seenMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/callers`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-token", "content-type": "application/json" },
      body: JSON.stringify({
        caller_id: "stateless-bot",
        caller_label: "Stateless Bot",
        caller_authority: "stateless_call"
      })
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { caller_id: string; caller_authority: string };
    assert.equal(payload.caller_id, "stateless-bot");
    assert.equal(payload.caller_authority, "stateless_call");
  }, {
    requestAdminHub: async (message: HubMessage) => {
      seenMessages.push(message);
      const body = JSON.parse(message.payload.content as string) as Record<string, unknown>;
      assert.equal(body.caller_authority, "stateless_call");
      return {
        trace_id: message.trace_id,
        thread_id: "global",
        source: "codex",
        status: "success",
        content: JSON.stringify({
          caller_id: "stateless-bot",
          caller_key: "cleartext-stateless",
          caller_authority: "stateless_call"
        }),
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0]?.intent, "register_caller");
});

test("POST /api/callers returns 401 without Bearer token", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/callers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caller_id: "my-bot", caller_label: "My Bot" })
    });
    assert.equal(response.status, 401);
  }, {
    requestAdminHub: async () => { throw new Error("requestAdminHub should not be called"); }
  });
});

test("POST /api/callers returns 409 on caller_id collision", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/callers`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-token", "content-type": "application/json" },
      body: JSON.stringify({ caller_id: "existing-bot", caller_label: "Existing Bot" })
    });
    assert.equal(response.status, 409);
  }, {
    requestAdminHub: async (message: HubMessage) => ({
      trace_id: message.trace_id,
      thread_id: "global",
      source: "codex",
      status: "error",
      content: "caller_already_exists: existing-bot",
      attachments: [],
      timestamp: new Date().toISOString()
    })
  });
});

test("POST /api/callers returns 400 for invalid caller_id (bad regex)", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/callers`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-token", "content-type": "application/json" },
      body: JSON.stringify({ caller_id: "INVALID-UPPERCASE", caller_label: "Bad Bot" })
    });
    assert.equal(response.status, 400);
  }, {
    requestAdminHub: async () => { throw new Error("requestAdminHub should not be called"); }
  });
});

test("POST /api/callers/:id/rotate returns new cleartext key", async () => {
  const seenMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/callers/my-bot/rotate`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-token" }
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { caller_key: string };
    assert.equal(typeof payload.caller_key, "string");
    assert.ok(payload.caller_key.length > 0);
  }, {
    requestAdminHub: async (message: HubMessage) => {
      seenMessages.push(message);
      return {
        trace_id: message.trace_id,
        thread_id: "global",
        source: "codex",
        status: "success",
        content: JSON.stringify({ caller_key: "new-cleartext-xyz789" }),
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0]?.intent, "rotate_caller_key");
  assert.equal((seenMessages[0]?.caller as { caller_id?: string })?.caller_id, "meridian-admin");
});

test("PATCH /api/callers/:id/authority updates caller authority", async () => {
  const seenMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/callers/my-bot/authority`, {
      method: "PATCH",
      headers: { Authorization: "Bearer secret-token", "content-type": "application/json" },
      body: JSON.stringify({ caller_authority: "read" })
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { caller_id: string; caller_authority: string };
    assert.equal(payload.caller_id, "my-bot");
    assert.equal(payload.caller_authority, "read");
  }, {
    requestAdminHub: async (message: HubMessage) => {
      seenMessages.push(message);
      return {
        trace_id: message.trace_id,
        thread_id: "global",
        source: "codex",
        status: "success",
        content: JSON.stringify({ caller_id: "my-bot", caller_authority: "read" }),
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0]?.intent, "update_caller_authority");
});

test("POST /api/callers/:id/rotate returns 401 without Bearer token", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/callers/my-bot/rotate`, { method: "POST" });
    assert.equal(response.status, 401);
  }, {
    requestAdminHub: async () => { throw new Error("requestAdminHub should not be called"); }
  });
});

test("POST /api/callers/meridian-web/rotate returns 400 for built-in caller", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/callers/meridian-web/rotate`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-token" }
    });
    assert.equal(response.status, 400);
    const payload = (await response.json()) as { error: string };
    assert.match(payload.error, /built-in/i);
  }, {
    requestAdminHub: async () => { throw new Error("requestAdminHub should not be called"); }
  });
});

test("POST /api/callers/:id/rotate returns 404 for unknown caller", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/callers/nonexistent/rotate`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-token" }
    });
    assert.equal(response.status, 404);
  }, {
    requestAdminHub: async (message: HubMessage) => ({
      trace_id: message.trace_id,
      thread_id: "global",
      source: "codex",
      status: "error",
      content: "caller_unknown: nonexistent",
      attachments: [],
      timestamp: new Date().toISOString()
    })
  });
});

test("DELETE /api/callers/:id revokes a caller and returns revoked_at", async () => {
  const seenMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/callers/my-bot`, {
      method: "DELETE",
      headers: { Authorization: "Bearer secret-token" }
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { revoked_at: string };
    assert.equal(typeof payload.revoked_at, "string");
  }, {
    requestAdminHub: async (message: HubMessage) => {
      seenMessages.push(message);
      return {
        trace_id: message.trace_id,
        thread_id: "global",
        source: "codex",
        status: "success",
        content: JSON.stringify({ revoked_at: new Date().toISOString() }),
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0]?.intent, "unregister_caller");
  assert.equal((seenMessages[0]?.caller as { caller_id?: string })?.caller_id, "meridian-admin");
});

test("DELETE /api/callers/:id returns 401 without Bearer token", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/callers/my-bot`, { method: "DELETE" });
    assert.equal(response.status, 401);
  }, {
    requestAdminHub: async () => { throw new Error("requestAdminHub should not be called"); }
  });
});

test("DELETE /api/callers/meridian-admin returns 400 for built-in caller", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/callers/meridian-admin`, {
      method: "DELETE",
      headers: { Authorization: "Bearer secret-token" }
    });
    assert.equal(response.status, 400);
    const payload = (await response.json()) as { error: string };
    assert.match(payload.error, /built-in/i);
  }, {
    requestAdminHub: async () => { throw new Error("requestAdminHub should not be called"); }
  });
});

test("DELETE /api/callers/:id returns 404 for unknown caller", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/callers/nonexistent`, {
      method: "DELETE",
      headers: { Authorization: "Bearer secret-token" }
    });
    assert.equal(response.status, 404);
  }, {
    requestAdminHub: async (message: HubMessage) => ({
      trace_id: message.trace_id,
      thread_id: "global",
      source: "codex",
      status: "error",
      content: "caller_unknown: nonexistent",
      attachments: [],
      timestamp: new Date().toISOString()
    })
  });
});

test("non-admin route /api/spawn forwards inbound X-Meridian-Caller-Id into hub envelope caller field", async () => {
  const seenMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/spawn`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "content-type": "application/json",
        "X-Meridian-Caller-Id": "external-bot",
        "X-Meridian-Caller-Key": "some-key-value"
      },
      body: JSON.stringify({ type: "codex" })
    });
    assert.equal(response.status, 200);
  }, {
    requestHubAsCaller: async (message: HubMessage) => {
      seenMessages.push(message);
      return {
        trace_id: message.trace_id,
        thread_id: "codex_new",
        source: "codex",
        status: "success",
        content: "{}",
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });

  assert.equal(seenMessages.length, 1);
  const callerField = seenMessages[0]?.caller as { caller_id?: string } | undefined;
  assert.equal(callerField?.caller_id, "external-bot");
});

test("non-admin route /api/spawn signs hub socket request with inbound caller headers", async () => {
  const seenAuth: Array<{ caller_id: string; caller_key: string }> = [];
  const seenMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/spawn`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "content-type": "application/json",
        "X-Meridian-Caller-Id": "meridian-roles",
        "X-Meridian-Caller-Key": "roles-key"
      },
      body: JSON.stringify({ type: "codex" })
    });
    assert.equal(response.status, 200);
  }, {
    requestHub: async (message: HubMessage) => {
      throw new Error(`requestHub should not receive inbound caller request: ${message.intent}`);
    },
    requestHubAsCaller: async (
      message: HubMessage,
      auth: { caller_id: string; caller_key: string }
    ) => {
      seenMessages.push(message);
      seenAuth.push(auth);
      return {
        trace_id: message.trace_id,
        thread_id: "codex_new",
        source: "codex",
        status: "success",
        content: "{}",
        attachments: [],
        timestamp: new Date().toISOString()
      };
    }
  });

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0]?.caller?.caller_id, "meridian-roles");
  assert.deepEqual(seenAuth, [{ caller_id: "meridian-roles", caller_key: "roles-key" }]);
});

test("startWebInterfaceServer sets meridian-web caller identity when bootstrap key is present", async () => {
  const { startWebInterfaceServer } = await webServerModulePromise;
  const { clearCallerIdentity, hasCallerIdentity } = await import("../interface/ipc-sender");

  clearCallerIdentity();
  await withEnv({ MERIDIAN_INTERNAL_BOOTSTRAP_KEY: "test-bootstrap-seed-web" }, async () => {
    await startWebInterfaceServer({ enabled: false });
    assert.equal(hasCallerIdentity(), true);
  });
  clearCallerIdentity();
});

test("startWebInterfaceServer throws bootstrap_key_missing when MERIDIAN_INTERNAL_BOOTSTRAP_KEY is absent", async () => {
  const { startWebInterfaceServer } = await webServerModulePromise;

  await withEnv({ MERIDIAN_INTERNAL_BOOTSTRAP_KEY: undefined }, async () => {
    await assert.rejects(
      () => startWebInterfaceServer({ enabled: false }),
      /bootstrap_key_missing/
    );
  });
});

test("isHubSocketUnreachableMessage matches only genuine hub-socket connect failures", async () => {
  const { isHubSocketUnreachableMessage } = await webServerModulePromise;

  // Hub-socket unreachable — must match
  assert.equal(isHubSocketUnreachableMessage("connect ENOENT /tmp/meridian.sock"), true);
  assert.equal(isHubSocketUnreachableMessage("connect ECONNREFUSED 127.0.0.1:1234"), true);
  assert.equal(isHubSocketUnreachableMessage("connect ENOTSOCK /tmp/meridian.sock"), true);
  assert.equal(isHubSocketUnreachableMessage("IPC send connect timed out after 5000ms"), true);
  assert.equal(isHubSocketUnreachableMessage("IPC request connect timed out after 120000ms"), true);

  // Unrelated ENOENT / ECONNREFUSED — must NOT match. Prior substring matching
  // mis-attributed these as "Hub is not reachable" and stalled dispatchers.
  assert.equal(
    isHubSocketUnreachableMessage("ENOENT: no such file or directory, open '/Users/foo/dispatch_plan.md'"),
    false
  );
  assert.equal(
    isHubSocketUnreachableMessage("Failed to load credential bundle: ENOENT: no such file"),
    false
  );
  assert.equal(
    isHubSocketUnreachableMessage("upstream fetch failed: ECONNREFUSED https://api.example.com"),
    false
  );

  // IPC request timeout (post-connect) is hub overload, not hub-unreachable —
  // friendlyErrorMessage routes those to "Request timed out — the hub may be overloaded".
  assert.equal(isHubSocketUnreachableMessage("IPC request timed out after 120000ms"), false);
});

test("/api/health surfaces hub-socket-unreachable only when the underlying error is genuinely a connect failure", async () => {
  let scriptedContent = "";

  await withServer(async ({ baseUrl }) => {
    // 1. Genuine hub-socket connect failure → friendly "Hub is not reachable".
    scriptedContent = "connect ENOENT /tmp/meridian.sock";
    let response = await fetch(`${baseUrl}/api/health?token=secret-token`);
    assert.equal(response.status, 503);
    let payload = (await response.json()) as { ok: boolean; error: string };
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Hub is not reachable/);

    // 2. Unrelated ENOENT (e.g. missing artifact on disk) → must NOT translate to
    //    "Hub is not reachable". This is the bug that left dispatcher operators
    //    paused with a misleading surface message when the hub was healthy.
    scriptedContent = "ENOENT: no such file or directory, open '/Users/foo/dispatch_plan.md'";
    response = await fetch(`${baseUrl}/api/health?token=secret-token`);
    assert.equal(response.status, 503);
    payload = (await response.json()) as { ok: boolean; error: string };
    assert.equal(payload.ok, false);
    assert.doesNotMatch(payload.error, /Hub is not reachable/);
    assert.match(payload.error, /Server error:.*dispatch_plan\.md/);
  }, {
    requestHub: async (message: HubMessage) => ({
      trace_id: message.trace_id,
      thread_id: "global",
      source: "codex",
      status: "error" as const,
      content: scriptedContent,
      attachments: [],
      timestamp: new Date().toISOString()
    })
  });
});
