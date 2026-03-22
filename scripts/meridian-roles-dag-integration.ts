/**
 * End-to-end: integration Hub (stub agentapi) + meridian-roles Dispatcher with
 * explicit target_thread_id per task, socket reply_channel back to roles.
 *
 * Run from Meridian repo root:
 *   npx tsx scripts/meridian-roles-dag-integration.ts
 */
import assert from "node:assert/strict";
import path from "node:path";

import { setIntegrationTestEnv } from "../tests/integration/helpers/env";
import { startIntegrationHub } from "../tests/integration/helpers/hub-server";
import { buildHubMessage, sendHubIpc } from "../tests/integration/helpers/hub-ipc";

async function main(): Promise<void> {
  setIntegrationTestEnv();

  const { hubSocketPath, tempDir, cleanup } = await startIntegrationHub();
  const rolesSocketPath = path.join(tempDir, "meridian-roles-callback.sock");
  const statePath = path.join(tempDir, "meridian-roles-state.json");
  const guiPort = 17_701;

  process.env.HUB_SOCKET_PATH = hubSocketPath;
  process.env.ROLES_SOCKET_PATH = rolesSocketPath;
  process.env.STATE_FILE_PATH = statePath;
  process.env.GUI_PORT = String(guiPort);

  const { startMeridianRolesService } = await import("../Meridian-roles/src/index.ts");

  const service = await startMeridianRolesService();
  await new Promise((r) => setTimeout(r, 1500));

  try {
    const spawnCodex = await sendHubIpc(
      hubSocketPath,
      buildHubMessage({ intent: "spawn", target: "codex" })
    );
    assert.equal(spawnCodex.status, "success", `spawn codex: ${spawnCodex.content}`);

    const spawnGemini = await sendHubIpc(
      hubSocketPath,
      buildHubMessage({ intent: "spawn", target: "gemini" })
    );
    assert.equal(spawnGemini.status, "success", `spawn gemini: ${spawnGemini.content}`);

    const dispatcherThreadId = "dispatcher-scoped-260321";
    const userReplyPath = path.join(tempDir, "user-reply.sock");

    // Narrow task domain: fixed-string replies only — limits overflow vs open-ended prompts.
    const createBody = {
      thread_id: dispatcherThreadId,
      system_prompt:
        "Closed integration test. Reply with the exact text requested in the user message. " +
        "Do not browse the web, do not read repositories, do not add explanations or markdown fences.",
      user_reply_channel: {
        channel: "socket" as const,
        chat_id: "integration:test",
        socket_path: userReplyPath
      },
      tasks: [
        {
          task_id: "T1",
          instruction:
            "Output exactly one line containing only: WORKER_A_BOUND_OK (no other characters before or after).",
          depends_on: [] as string[],
          target_thread_id: "codex_01"
        },
        {
          task_id: "T2",
          instruction:
            "Output exactly one line containing only: WORKER_B_BOUND_OK (no other characters before or after).",
          depends_on: ["T1"],
          target_thread_id: "gemini_01"
        }
      ]
    };

    const createRes = await fetch(`http://127.0.0.1:${guiPort}/api/role`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createBody)
    });
    assert.equal(createRes.status, 201, await createRes.text());

    const deadline = Date.now() + 45_000;
    let last: { tasks?: Array<{ task_id: string; status: string }> } = {};
    while (Date.now() < deadline) {
      const r = await fetch(`http://127.0.0.1:${guiPort}/api/role/${encodeURIComponent(dispatcherThreadId)}`);
      if (r.ok) {
        last = (await r.json()) as typeof last;
        const tasks = last.tasks ?? [];
        if (
          tasks.length >= 2 &&
          tasks.every((t) => t.status === "done" || t.status === "failed")
        ) {
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    const finalRes = await fetch(`http://127.0.0.1:${guiPort}/api/role/${encodeURIComponent(dispatcherThreadId)}`);
    assert.equal(finalRes.status, 200);
    const detail = (await finalRes.json()) as {
      tasks: Array<{ task_id: string; status: string; trace_id?: string }>;
    };

    console.log(JSON.stringify(detail, null, 2));

    assert.ok(detail.tasks.length >= 2, "expected at least two tasks");
    assert.ok(
      detail.tasks.every((t) => t.status === "done"),
      `expected all tasks done, got: ${detail.tasks.map((t) => `${t.task_id}:${t.status}`).join(", ")}`
    );
    assert.ok(detail.tasks.every((t) => t.trace_id && t.trace_id !== "—"), "trace_id prefix should be set");

    const patchPrompt = await fetch(
      `http://127.0.0.1:${guiPort}/api/role/${encodeURIComponent(dispatcherThreadId)}/prompt`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt: "Updated coordination prompt via API." })
      }
    );
    assert.equal(patchPrompt.status, 200, await patchPrompt.text());

    console.log("OK: meridian-roles + integration Hub DAG completed (codex_01 -> gemini_01).");
  } finally {
    await service.close();
    await cleanup();
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
