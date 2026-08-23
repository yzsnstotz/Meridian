import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { HubMessage, HubResult } from "../types";

process.env.TELEGRAM_BOT_TOKEN ??= "123456789:test_token";
process.env.ALLOWED_USER_IDS ??= "123456789";
process.env.MERIDIAN_DISABLE_WEB_AUTOSTART = "true";

const webServerModulePromise = import("./server");

async function createStaticDir(): Promise<string> {
  const staticDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-web-static-cred-e3-"));
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
    await callback({ baseUrl: `http://127.0.0.1:${address.port}` });
  } finally {
    await server.stop();
    await fs.promises.rm(staticDir, { recursive: true, force: true });
  }
}

function makeOkResult(message: HubMessage, payload: Record<string, unknown>): HubResult {
  return {
    trace_id: message.trace_id,
    thread_id: message.thread_id ?? "global",
    source: "codex",
    status: "success",
    content: JSON.stringify(payload),
    attachments: [],
    timestamp: new Date().toISOString()
  };
}

function makeErrResult(message: HubMessage, errPayload: Record<string, unknown>): HubResult {
  return {
    trace_id: message.trace_id,
    thread_id: message.thread_id ?? "global",
    source: "codex",
    status: "error",
    content: JSON.stringify(errPayload),
    attachments: [],
    timestamp: new Date().toISOString()
  };
}

test("POST /api/credentials/oauth-login returns 202 with {job_id, status}", async () => {
  const seenMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/credentials/oauth-login`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "content-type": "application/json",
        "X-Meridian-Caller-Id": "alice",
        "X-Meridian-Caller-Key": "alice-key"
      },
      body: JSON.stringify({ credential_label: "oauth-test" })
    });
    assert.equal(response.status, 202);
    const body = (await response.json()) as { job_id: string; status: string };
    assert.equal(body.job_id, "j-1");
    assert.equal(body.status, "pending");
  }, {
    requestHubAsCaller: async (message: HubMessage) => {
      seenMessages.push(message);
      return makeOkResult(message, { job_id: "j-1", status: "pending" });
    }
  });

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0]?.intent, "register_credential_oauth_start");
});

test("GET /api/credentials/oauth-login/:jobId returns 200 with status payload", async () => {
  const seenMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/credentials/oauth-login/j-42`, {
      headers: {
        Authorization: "Bearer secret-token",
        "X-Meridian-Caller-Id": "alice",
        "X-Meridian-Caller-Key": "alice-key"
      }
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { job_id: string; status: string };
    assert.equal(body.job_id, "j-42");
    assert.equal(body.status, "awaiting_browser");
  }, {
    requestHubAsCaller: async (message: HubMessage) => {
      seenMessages.push(message);
      return makeOkResult(message, { job_id: "j-42", status: "awaiting_browser" });
    }
  });

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0]?.intent, "register_credential_oauth_poll");
  const content = JSON.parse(seenMessages[0]!.payload.content) as { job_id: string };
  assert.equal(content.job_id, "j-42");
});

test("DELETE /api/credentials/oauth-login/:jobId returns 204", async () => {
  const seenMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/credentials/oauth-login/j-cancel`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer secret-token",
        "X-Meridian-Caller-Id": "alice",
        "X-Meridian-Caller-Key": "alice-key"
      }
    });
    assert.equal(response.status, 204);
    const text = await response.text();
    assert.equal(text, "");
  }, {
    requestHubAsCaller: async (message: HubMessage) => {
      seenMessages.push(message);
      return makeOkResult(message, { job_id: "j-cancel", status: "cancelled" });
    }
  });

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0]?.intent, "register_credential_oauth_cancel");
});

test("POST /api/credentials/oauth-login returns 429 when error_code is oauth_login_cap_exceeded", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/credentials/oauth-login`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "content-type": "application/json",
        "X-Meridian-Caller-Id": "alice",
        "X-Meridian-Caller-Key": "alice-key"
      },
      body: JSON.stringify({ credential_label: "too-many" })
    });
    assert.equal(response.status, 429);
    const body = (await response.json()) as { error_code?: string };
    assert.equal(body.error_code, "oauth_login_cap_exceeded");
  }, {
    requestHubAsCaller: async (message: HubMessage) => makeErrResult(message, {
      error_code: "oauth_login_cap_exceeded",
      error_message: "too many concurrent login jobs"
    })
  });
});
