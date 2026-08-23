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
  const staticDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-web-static-cred-e1-"));
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

test("GET /api/credentials returns 200 with credentials list for authenticated caller", async () => {
  const seenMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/credentials`, {
      headers: {
        Authorization: "Bearer secret-token",
        "X-Meridian-Caller-Id": "alice",
        "X-Meridian-Caller-Key": "alice-key"
      }
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { credentials: Array<Record<string, unknown>> };
    assert.ok(Array.isArray(body.credentials));
    assert.equal(body.credentials[0]?.credential_id, "cred-1");
  }, {
    requestHubAsCaller: async (message: HubMessage) => {
      seenMessages.push(message);
      return makeOkResult(message, {
        credentials: [
          { credential_id: "cred-1", credential_label: "test", provider: "codex", kind: "api_key", owner_caller_id: "alice", is_default: false }
        ]
      });
    }
  });

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0]?.intent, "list_credentials");
});

test("DELETE /api/credentials/:id returns 200 for owner", async () => {
  const seenMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/credentials/cred-7`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer secret-token",
        "X-Meridian-Caller-Id": "alice",
        "X-Meridian-Caller-Key": "alice-key"
      }
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { credential_id: string; revoked: boolean };
    assert.equal(body.credential_id, "cred-7");
    assert.equal(body.revoked, true);
  }, {
    requestHubAsCaller: async (message: HubMessage) => {
      seenMessages.push(message);
      return makeOkResult(message, { credential_id: "cred-7", revoked: true });
    }
  });

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0]?.intent, "revoke_credential");
  const content = JSON.parse(seenMessages[0]!.payload.content) as { credential_id: string };
  assert.equal(content.credential_id, "cred-7");
});

test("DELETE /api/credentials/:id returns 403 for non-owner non-admin (credential_forbidden)", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/credentials/cred-9`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer secret-token",
        "X-Meridian-Caller-Id": "mallory",
        "X-Meridian-Caller-Key": "mallory-key"
      }
    });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error_code?: string };
    assert.equal(body.error_code, "credential_forbidden");
  }, {
    requestHubAsCaller: async (message: HubMessage) => makeErrResult(message, {
      error_code: "credential_forbidden",
      credential_id: "cred-9"
    })
  });
});

test("DELETE /api/credentials/:id returns 404 when credential_not_found", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/credentials/missing`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer secret-token",
        "X-Meridian-Caller-Id": "alice",
        "X-Meridian-Caller-Key": "alice-key"
      }
    });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error_code?: string };
    assert.equal(body.error_code, "credential_not_found");
  }, {
    requestHubAsCaller: async (message: HubMessage) => makeErrResult(message, {
      error_code: "credential_not_found",
      credential_id: "missing"
    })
  });
});

test("PATCH /api/credentials/:id returns 200 and updates label", async () => {
  const seenMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/credentials/cred-5`, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer secret-token",
        "content-type": "application/json",
        "X-Meridian-Caller-Id": "alice",
        "X-Meridian-Caller-Key": "alice-key"
      },
      body: JSON.stringify({ credential_label: "new-label" })
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { credential_id: string; updated: boolean };
    assert.equal(body.credential_id, "cred-5");
    assert.equal(body.updated, true);
  }, {
    requestHubAsCaller: async (message: HubMessage) => {
      seenMessages.push(message);
      return makeOkResult(message, { credential_id: "cred-5", updated: true });
    }
  });

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0]?.intent, "update_credential");
  const content = JSON.parse(seenMessages[0]!.payload.content) as { credential_id: string; credential_label?: string };
  assert.equal(content.credential_id, "cred-5");
  assert.equal(content.credential_label, "new-label");
});

test("POST /api/credentials/:id/default returns 200 and flips is_default", async () => {
  const seenMessages: HubMessage[] = [];

  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/credentials/cred-3/default`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "X-Meridian-Caller-Id": "alice",
        "X-Meridian-Caller-Key": "alice-key"
      }
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { credential_id: string; is_default: boolean };
    assert.equal(body.credential_id, "cred-3");
    assert.equal(body.is_default, true);
  }, {
    requestHubAsCaller: async (message: HubMessage) => {
      seenMessages.push(message);
      return makeOkResult(message, { credential_id: "cred-3", is_default: true });
    }
  });

  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0]?.intent, "set_default_credential");
});

test("GET /api/credentials returns 401 without Bearer token", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/credentials`);
    assert.equal(response.status, 401);
  }, {
    requestHubAsCaller: async () => { throw new Error("requestHubAsCaller should not be called"); }
  });
});

test("DELETE /api/credentials/:id returns 503 when credential_store_unavailable", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/credentials/cred-1`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer secret-token",
        "X-Meridian-Caller-Id": "alice",
        "X-Meridian-Caller-Key": "alice-key"
      }
    });
    assert.equal(response.status, 503);
  }, {
    requestHubAsCaller: async (message: HubMessage) => makeErrResult(message, {
      error_code: "credential_store_unavailable"
    })
  });
});
