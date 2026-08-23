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
  const staticDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-web-static-cred-e2-"));
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

test("POST /api/credentials/api-key returns 201 with {credential_id}", async () => {
  const seenMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/credentials/api-key`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "content-type": "application/json",
        "X-Meridian-Caller-Id": "alice",
        "X-Meridian-Caller-Key": "alice-key"
      },
      body: JSON.stringify({
        credential_label: "my-key",
        base_url: "https://api.example.com",
        model_id: "gpt-x",
        env_var: "EXAMPLE_KEY",
        key_value: "sk-test"
      })
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { credential_id: string };
    assert.equal(body.credential_id, "cred-new");
  }, {
    requestHubAsCaller: async (message: HubMessage) => {
      seenMessages.push(message);
      return makeOkResult(message, { credential_id: "cred-new" });
    }
  });

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0]?.intent, "register_credential_api_key");
});

test("POST /api/credentials/api-key returns 400 on invalid_payload error from intent", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/credentials/api-key`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "content-type": "application/json",
        "X-Meridian-Caller-Id": "alice",
        "X-Meridian-Caller-Key": "alice-key"
      },
      body: JSON.stringify({ credential_label: "missing-fields" })
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error_code?: string };
    assert.equal(body.error_code, "invalid_payload");
  }, {
    requestHubAsCaller: async (message: HubMessage) => makeErrResult(message, {
      error_code: "invalid_payload",
      error_message: "missing required fields"
    })
  });
});

test("POST /api/credentials/api-key forwards body untouched (owner_caller_id passed through)", async () => {
  const seenMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/credentials/api-key`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "content-type": "application/json",
        "X-Meridian-Caller-Id": "alice",
        "X-Meridian-Caller-Key": "alice-key"
      },
      body: JSON.stringify({
        credential_label: "my-key",
        owner_caller_id: "smuggled-id",
        base_url: "https://api.example.com",
        model_id: "gpt-x",
        env_var: "EXAMPLE_KEY",
        key_value: "sk-test"
      })
    });
    assert.equal(response.status, 201);
  }, {
    requestHubAsCaller: async (message: HubMessage) => {
      seenMessages.push(message);
      return makeOkResult(message, { credential_id: "cred-2" });
    }
  });

  assert.equal(seenMessages.length, 1);
  const content = JSON.parse(seenMessages[0]!.payload.content) as Record<string, unknown>;
  // The HTTP layer passes the body through as-is; the intent layer (tested in D3)
  // is responsible for ignoring/overriding owner_caller_id.
  assert.equal(content.owner_caller_id, "smuggled-id");
  assert.equal(content.credential_label, "my-key");
  assert.equal(content.key_value, "sk-test");
});
