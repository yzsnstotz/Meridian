/**
 * INT-08: Idempotency — same idempotency_key twice returns cached result.
 * Assert: two run requests with same idempotency_key return same content (second from cache).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { setIntegrationTestEnv } from "./helpers/env";
import { startIntegrationHub } from "./helpers/hub-server";
import { buildHubMessage, sendHubIpc } from "./helpers/hub-ipc";

setIntegrationTestEnv();

test("INT-08: duplicate idempotency_key returns cached result", async () => {
  const { hubSocketPath, cleanup } = await startIntegrationHub();

  try {
    const threadId = "codex_01";
    const idemKey = "idem-test-001";

    await sendHubIpc(hubSocketPath, buildHubMessage({ intent: "spawn", target: "codex" }));

    const run1 = await sendHubIpc(hubSocketPath, buildHubMessage({
      intent: "run",
      thread_id: threadId,
      target: threadId,
      idempotency_key: idemKey,
      payload: { content: "once", raw_message_id: "run-1", reply_to: null }
    }));
    assert.equal(run1.status, "success");

    const run2 = await sendHubIpc(hubSocketPath, buildHubMessage({
      intent: "run",
      thread_id: threadId,
      target: threadId,
      idempotency_key: idemKey,
      payload: { content: "once", raw_message_id: "run-2", reply_to: null }
    }));
    assert.equal(run2.status, "success");
    assert.equal(run2.content, run1.content, "second request should return cached content");

    await sendHubIpc(hubSocketPath, buildHubMessage({ intent: "kill", thread_id: threadId, target: threadId }));
  } finally {
    await cleanup();
  }
});
