/**
 * INT-04: reboot keeps thread_id, updates pid.
 * Assert: spawn → status (record pid) → reboot → status (same thread_id, different pid).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { setIntegrationTestEnv } from "./helpers/env";
import { startIntegrationHub } from "./helpers/hub-server";
import { buildHubMessage, sendHubIpc } from "./helpers/hub-ipc";

setIntegrationTestEnv();

test("INT-04: reboot preserves thread_id and updates pid", async () => {
  const { hubSocketPath, cleanup } = await startIntegrationHub();

  try {
    const threadId = "codex_01";

    await sendHubIpc(hubSocketPath, buildHubMessage({ intent: "spawn", target: "codex" }));

    const status1 = await sendHubIpc(hubSocketPath, buildHubMessage({
      intent: "status",
      thread_id: threadId,
      target: threadId
    }));
    assert.equal(status1.status, "success");
    const pid1 = extractPidFromStatusContent(status1.content);

    const rebootRes = await sendHubIpc(hubSocketPath, buildHubMessage({
      intent: "reboot",
      thread_id: threadId,
      target: threadId
    }));
    assert.equal(rebootRes.status, "success");

    const status2 = await sendHubIpc(hubSocketPath, buildHubMessage({
      intent: "status",
      thread_id: threadId,
      target: threadId
    }));
    assert.equal(status2.status, "success");
    const pid2 = extractPidFromStatusContent(status2.content);

    assert.ok(pid1 !== undefined && pid2 !== undefined);
    assert.notEqual(pid2, pid1, "pid should change after reboot");

    await sendHubIpc(hubSocketPath, buildHubMessage({ intent: "kill", thread_id: threadId, target: threadId }));
  } finally {
    await cleanup();
  }
});

function extractPidFromStatusContent(content: string): number | undefined {
  const m = content.match(/"pid"\s*:\s*(\d+)/);
  return m ? Number(m[1]) : undefined;
}
