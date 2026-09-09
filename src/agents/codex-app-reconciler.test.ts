import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AppHandoffQueue } from "./codex-app-queue";
import { observeCodexAppTurn, reconcileStartedAppRequest, type AppTurnObserver } from "./codex-app-reconciler";

const threadId = "01a07727-ac38-7c23-8ef3-4bc90f594b9a";
const turnId = "native-turn";
const controller = "codex-app-controller";

function fixture(state: "started" | "cancel_requested" = "started") {
  const directory = mkdtempSync(path.join(os.tmpdir(), "meridian-app-reconcile-"));
  const queue = new AppHandoffQueue(directory);
  queue.create({
    id: "request-one",
    workerId: "worker-one",
    cwd: "/tmp/work",
    prompt: "Run the assigned task"
  });
  queue.claim("request-one", controller);
  queue.submit("request-one", controller);
  queue.bindThread("request-one", controller, threadId);
  queue.started("request-one", controller, turnId);
  if (state === "cancel_requested") queue.cancel("request-one");
  return {
    directory,
    queue,
    close: () => rmSync(directory, { recursive: true, force: true })
  };
}

test("real private SQLite/rollout error evidence reconciles once and null or malformed evidence stays reserved", async () => {
  for (const mode of ["error", "both", "null", "malformed", "cross-turn"] as const) {
    const f = fixture();
    try {
      const stateDatabase = path.join(f.directory, "state.sqlite");
      const rollout = path.join(f.directory, "rollout.jsonl");
      const db = new DatabaseSync(stateDatabase);
      db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT)");
      db.prepare("INSERT INTO threads VALUES (?, ?)").run(threadId, rollout);
      db.close();
      chmodSync(stateDatabase, 0o600);
      const terminal = { type: "task_complete", turn_id: mode === "cross-turn" ? "other-turn" : turnId,
        last_agent_message: mode === "both" || mode === "malformed" ? "Must not become success" : null,
        ...(mode === "null" ? {} : { error: { message: mode === "malformed" ? null : "Provider denied this request",
          codex_error_info: "some_code" } }) };
      writeFileSync(rollout, [
        { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
        { type: "response_item", payload: { role: "user", content: [{ text: "[Meridian App handoff request: request-one]" }] } },
        { type: "event_msg", payload: terminal }
      ].map(row => JSON.stringify(row)).join("\n"), { mode: 0o600 });
      const before = [readFileSync(stateDatabase), readFileSync(rollout)];
      const observe: AppTurnObserver = request => observeCodexAppTurn(request, {
        queueDirectory: f.directory, stateDatabase
      });
      const result = await reconcileStartedAppRequest(f.queue, "request-one", observe);
      if (mode === "error" || mode === "both") {
        assert.deepEqual(result, { outcome: "recovered", state: "failed" });
        assert.equal(f.queue.read("request-one").result?.text, "Provider denied this request");
        assert.equal(f.queue.list().length, 0);
        assert.equal((await reconcileStartedAppRequest(f.queue, "request-one", observe)).outcome, "already_terminal");
      } else {
        assert.deepEqual(result, { outcome: mode === "cross-turn" ? "not_terminal" : "needs_external_reconciliation", state: "started" });
        assert.equal(f.queue.read("request-one").result, undefined);
      }
      assert.deepEqual([readFileSync(stateDatabase), readFileSync(rollout)], before);
    } finally { f.close(); }
  }
});

test("recovers the exact completed App turn into the durable queue", async () => {
  const f = fixture();
  const observe: AppTurnObserver = async () => ({
    threadId,
    turnId,
    status: "completed",
    text: "Exact native final"
  });
  try {
    const result = await reconcileStartedAppRequest(f.queue, "request-one", observe);
    assert.deepEqual(result, { outcome: "recovered", state: "completed" });
    assert.deepEqual(f.queue.read("request-one").result, {
      threadId,
      turnId,
      status: "completed",
      text: "Exact native final"
    });
  } finally {
    f.close();
  }
});

test("leaves a running App turn reserved", async () => {
  const f = fixture();
  try {
    const result = await reconcileStartedAppRequest(f.queue, "request-one", async () => ({
      threadId,
      turnId,
      status: "running",
      progress: "Still testing"
    }));
    assert.deepEqual(result, { outcome: "not_terminal", state: "started" });
    assert.equal(f.queue.read("request-one").state, "started");
    assert.equal(f.queue.read("request-one").result, undefined);
  } finally {
    f.close();
  }
});

test("refuses terminal observations without a true final response", async () => {
  const f = fixture();
  try {
    const result = await reconcileStartedAppRequest(f.queue, "request-one", async () => ({
      threadId,
      turnId,
      status: "completed",
      text: "   "
    }));
    assert.deepEqual(result, { outcome: "needs_external_reconciliation", state: "started" });
    assert.equal(f.queue.read("request-one").state, "started");
  } finally {
    f.close();
  }
});

test("rejects a terminal result from any other native thread or turn", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      reconcileStartedAppRequest(f.queue, "request-one", async () => ({
        threadId: "01a07727-ac96-7881-9913-ae16f1029e92",
        turnId,
        status: "completed",
        text: "Wrong thread final"
      })),
      /thread\/turn mismatch/
    );
    await assert.rejects(
      reconcileStartedAppRequest(f.queue, "request-one", async () => ({
        threadId,
        turnId: "other-turn",
        status: "completed",
        text: "Wrong turn final"
      })),
      /thread\/turn mismatch/
    );
    assert.equal(f.queue.read("request-one").state, "started");
  } finally {
    f.close();
  }
});

test("terminal evidence closes a cancellation without reporting success", async () => {
  const f = fixture("cancel_requested");
  try {
    const result = await reconcileStartedAppRequest(f.queue, "request-one", async () => ({
      threadId,
      turnId,
      status: "interrupted",
      text: "Codex recorded this exact App turn as aborted."
    }));
    assert.deepEqual(result, { outcome: "recovered", state: "cancelled" });
    assert.equal(f.queue.read("request-one").state, "cancelled");
    assert.equal(f.queue.read("request-one").result?.status, "interrupted");
  } finally {
    f.close();
  }
});
