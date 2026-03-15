/**
 * INT-03: detach/attach lifecycle.
 * Assert: attach → detach → run returns error → re-attach → run succeeds.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { setIntegrationTestEnv } from "./helpers/env";
import { startIntegrationHub } from "./helpers/hub-server";
import { buildHubMessage, sendHubIpc } from "./helpers/hub-ipc";

setIntegrationTestEnv();

test("INT-03: detach then run returns error; re-attach then run succeeds", async () => {
  const { hubSocketPath, cleanup } = await startIntegrationHub();

  try {
    const threadId = "codex_01";

    await sendHubIpc(hubSocketPath, buildHubMessage({ intent: "spawn", target: "codex" }));
    await sendHubIpc(hubSocketPath, buildHubMessage({ intent: "detach", thread_id: threadId, target: threadId }));

    const runAfterDetach = await sendHubIpc(hubSocketPath, buildHubMessage({
      intent: "run",
      thread_id: "active",
      target: "active",
      payload: { content: "hi", raw_message_id: "run-1", reply_to: null },
      reply_channel: { channel: "telegram", chat_id: "telegram:123456789", message_id: "1", bot_id: "123456789" }
    }));
    assert.equal(runAfterDetach.status, "error");
    assert.match(runAfterDetach.content, /attach|thread/i);

    await sendHubIpc(hubSocketPath, buildHubMessage({ intent: "attach", thread_id: threadId, target: threadId }));

    const runAfterAttach = await sendHubIpc(hubSocketPath, buildHubMessage({
      intent: "run",
      thread_id: "active",
      target: "active",
      payload: { content: "hi", raw_message_id: "run-2", reply_to: null },
      reply_channel: { channel: "telegram", chat_id: "telegram:123456789", message_id: "2", bot_id: "123456789" }
    }));
    assert.equal(runAfterAttach.status, "success");

    await sendHubIpc(hubSocketPath, buildHubMessage({ intent: "kill", thread_id: threadId, target: threadId }));
  } finally {
    await cleanup();
  }
});
