import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AppHandoffQueue } from "./codex-app-queue";
import { reconcileStartedAppRequest, type AppTurnObserver } from "./codex-app-reconciler";

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
