/**
 * INT-01: Unix Socket full flow.
 * Assert: spawn → socket file exists → send run → receive result → kill → socket cleaned.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { setIntegrationTestEnv } from "./helpers/env";
import { startIntegrationHub } from "./helpers/hub-server";
import { buildHubMessage, sendHubIpc } from "./helpers/hub-ipc";

setIntegrationTestEnv();

test("INT-01: Unix Socket IPC — spawn creates socket file, run succeeds, kill removes socket", async () => {
  const { hubSocketPath, tempDir, cleanup } = await startIntegrationHub();

  try {
    const threadId = "codex_01";
    const agentSocketPath = path.join(tempDir, `agentapi-${threadId}.sock`);

    const spawnRes = await sendHubIpc(hubSocketPath, buildHubMessage({ intent: "spawn", target: "codex" }));
    assert.equal(spawnRes.status, "success");
    assert.ok(fs.existsSync(agentSocketPath), "socket file must exist after spawn");

    const runRes = await sendHubIpc(hubSocketPath, buildHubMessage({
      intent: "run",
      thread_id: threadId,
      target: threadId,
      payload: { content: "hello", raw_message_id: "run-1", reply_to: null }
    }));
    assert.equal(runRes.status, "success");

    const killRes = await sendHubIpc(hubSocketPath, buildHubMessage({ intent: "kill", thread_id: threadId, target: threadId }));
    assert.equal(killRes.status, "success");
    assert.ok(!fs.existsSync(agentSocketPath), "socket file must be removed after kill");
  } finally {
    await cleanup();
  }
});
