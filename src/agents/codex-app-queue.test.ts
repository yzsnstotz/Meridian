import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AppHandoffQueue } from "./codex-app-queue";

const thread = "01a07727-ac38-7c23-8ef3-4bc90f594b9a";
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meridian-app-test-"));
  return { queue: new AppHandoffQueue(dir), dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}
function request(id = "request-one", workerId = "worker-one") {
  return { id, workerId, threadId: thread, cwd: "/tmp/work", prompt: "Run the assigned task", model: "gpt-6-astra", effort: "xhigh" };
}

test("two callers get durable requests and only one controller can claim each", () => {
  const f = fixture();
  try {
    f.queue.create(request());
    f.queue.create({ ...request("request-two", "another-caller"), threadId: "01a07727-ac96-7881-9913-ae16f1029e92" });
    assert.equal(f.queue.list().length, 2);
    assert.equal(f.queue.claim("request-one", "controller-a").state, "claimed");
    assert.throws(() => f.queue.claim("request-one", "controller-b"), /claimed/);
    assert.equal(f.queue.read("request-one").workerId, "worker-one");
    assert.equal(f.queue.read("request-two").workerId, "another-caller");
  } finally { f.close(); }
});

test("same request is idempotent but conflicting content or active thread cannot duplicate execution", () => {
  const f = fixture();
  try {
    f.queue.create(request());
    assert.equal(f.queue.create(request()).id, "request-one");
    assert.throws(() => f.queue.create({ ...request(), prompt: "changed" }), /conflict/);
    assert.throws(() => f.queue.create(request("different-request")), /active/);
  } finally { f.close(); }
});

test("execution policy intent survives for unrelated workers and binds idempotent request identity", () => {
  const f = fixture();
  try {
    for (const [index, autoApprove] of [false, true].entries()) {
      const input = { ...request(`policy-${index}`, `opaque-${index}`), threadId: undefined,
        executionPolicy: { autoApprove, sandboxMode: "workspace-write" as const } };
      f.queue.create(input);
      assert.deepEqual(f.queue.read(input.id).executionPolicy, input.executionPolicy);
      assert.deepEqual(f.queue.create(input).executionPolicy, input.executionPolicy);
      assert.throws(() => f.queue.create({ ...input, executionPolicy: { autoApprove: !autoApprove, sandboxMode: "workspace-write" } }), /conflict/);
    }
    assert.throws(() => f.queue.create({ ...request("unsupported-policy", "opaque-third"),
      executionPolicy: { autoApprove: true, grantFullAccess: true } } as never), /Unrecognized/);
  } finally { f.close(); }
});

test("only the claimed App turn can complete, and failed turns cannot become successes", () => {
  const f = fixture();
  try {
    f.queue.create(request());
    f.queue.claim("request-one", "controller-a");
    f.queue.submit("request-one", "controller-a");
    f.queue.started("request-one", "controller-a", "turn-one");
    assert.throws(() => f.queue.complete("request-one", "controller-a", { threadId: thread, turnId: "old-turn", status: "completed", text: "old pass" }), /turn/);
    assert.throws(() => f.queue.complete("request-one", "controller-b", { threadId: thread, turnId: "turn-one", status: "completed", text: "pass" }), /controller/);
    f.queue.complete("request-one", "controller-a", { threadId: thread, turnId: "turn-one", status: "failed", text: "tool denied" });
    assert.equal(f.queue.read("request-one").state, "failed");
    assert.equal(f.queue.read("request-one").result?.text, "tool denied");
  } finally { f.close(); }
});

test("uncertain sends stay claimed; cancellation holds the original thread until App termination", () => {
  const f = fixture();
  try {
    f.queue.create(request());
    f.queue.claim("request-one", "controller-a");
    f.queue.submit("request-one", "controller-a");
    assert.equal(f.queue.list()[0].state, "claimed");
    f.queue.cancel("request-one");
    assert.equal(f.queue.read("request-one").state, "cancel_requested");
    assert.throws(() => f.queue.create(request("retry")), /active/);
    f.queue.started("request-one", "controller-a", "turn-one");
    f.queue.complete("request-one", "controller-a", { threadId: thread, turnId: "turn-one", status: "completed", text: "late result" });
    assert.equal(f.queue.read("request-one").state, "cancelled");
    assert.match(readFileSync(path.join(f.dir, "request-one.json"), "utf8"), /cancel_requested/);
  } finally { f.close(); }
});

test("a proven thread-start rejection releases only an unbound creation, never an uncertain or bound turn", () => {
  const f = fixture();
  try {
    const { threadId: _, ...input } = request();
    const rejection = { requestId: input.id, outcome: "not_started" as const, error: "Invalid configuration", evidence: "Native thread/start returned invalid_config without creating a thread; exact create receipt and RPC log retained." };
    f.queue.create(input);
    f.queue.claim(input.id, "controller");
    assert.throws(() => f.queue.rejectCreation(input.id, "controller", rejection), /submission/);
    f.queue.submit(input.id, "controller");
    assert.throws(() => f.queue.rejectCreation(input.id, "wrong", rejection), /controller/);
    assert.throws(() => f.queue.rejectCreation(input.id, "controller", { ...rejection, requestId: "another" }), /mismatch/);
    assert.throws(() => f.queue.rejectCreation(input.id, "controller", { ...rejection, outcome: "unknown" } as never));
    const failed = f.queue.rejectCreation(input.id, "controller", rejection);
    assert.equal(failed.state, "failed");
    assert.equal(failed.submissionAttempted, true);
    assert.equal(failed.result, undefined);
    assert.equal(f.queue.list().length, 0);
    assert.throws(() => f.queue.submit(input.id, "controller"), /never resend/);
    f.queue.create({ ...input, id: "cancelled-creation" });
    f.queue.claim("cancelled-creation", "controller");
    f.queue.submit("cancelled-creation", "controller");
    f.queue.observe("cancelled-creation", "controller", "original native receipt");
    f.queue.cancel("cancelled-creation");
    const cancelledRejection = { ...rejection, requestId: "cancelled-creation" };
    assert.throws(() => f.queue.rejectCreation("cancelled-creation", "controller", { ...cancelledRejection, error: " " }));
    assert.throws(() => f.queue.rejectCreation("cancelled-creation", "controller", { ...cancelledRejection, evidence: " " }));
    const rejected = f.queue.rejectCreation("cancelled-creation", "controller", cancelledRejection);
    assert.equal(rejected.state, "failed");
    assert.deepEqual(JSON.parse(rejected.receipt!), { submissionReceipt: "original native receipt", rejection: cancelledRejection });
    f.queue.create(request("bound"));
    f.queue.claim("bound", "controller");
    f.queue.submit("bound", "controller");
    assert.throws(() => f.queue.rejectCreation("bound", "controller", { ...rejection, requestId: "bound" }), /bound/);
    assert.equal(f.queue.read("bound").state, "claimed");
  } finally { f.close(); }
});

test("path traversal and malformed thread IDs are rejected", () => {
  const f = fixture();
  try {
    assert.throws(() => f.queue.create(request("../escape")), /identifier/);
    assert.throws(() => f.queue.create({ ...request(), threadId: "not-a-thread" }), /thread/);
  } finally { f.close(); }
});

test("new App workers bind the native-created thread once; ambiguous creation cannot be reclaimed", () => {
  const f = fixture();
  try {
    const { threadId: _, ...input } = request();
    f.queue.create(input);
    f.queue.claim(input.id, "app-controller");
    f.queue.submit(input.id, "app-controller");
    assert.equal(f.queue.read(input.id).threadId, undefined);
    f.queue.bindThread(input.id, "app-controller", thread);
    assert.equal(f.queue.read(input.id).threadId, thread);
    assert.throws(() => f.queue.bindThread(input.id, "app-controller", "01a07727-ac96-7881-9913-ae16f1029e92"), /conflict/);
    assert.throws(() => f.queue.claim(input.id, "another-controller"), /claimed/);
  } finally { f.close(); }
});

test("a killed lock owner cannot strand the queue or let another writer steal a live lock", async () => {
  const { spawn } = await import("node:child_process");
  const f = fixture();
  const lockPath = path.join(f.dir, ".transition.flock");
  const child = spawn(process.execPath, ["-e", `
    const fs=require('node:fs'); const {flockSync}=require('fs-ext');
    const fd=fs.openSync(process.argv[1],'a',0o600); flockSync(fd,'ex');
    process.stdout.write('locked'); setInterval(()=>{},1000);
  `, lockPath], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(child.stdout!, "data");
    const { openSync, closeSync } = await import("node:fs");
    const { flockSync } = await import("fs-ext");
    const fd = openSync(lockPath, "a");
    try { assert.throws(() => flockSync(fd, "exnb"), /EAGAIN|EWOULDBLOCK/); }
    finally { closeSync(fd); }
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    assert.equal(f.queue.create(request()).state, "pending");
  } finally { child.kill("SIGKILL"); f.close(); }
});

test("cancellation before durable submission intent is terminal and forbids launching later", () => {
  const f = fixture();
  try {
    f.queue.create(request());
    f.queue.claim("request-one", "controller");
    assert.equal(f.queue.cancel("request-one").state, "cancelled");
    assert.throws(() => f.queue.submit("request-one", "controller"), /not allowed/);
    assert.equal(f.queue.create(request("next-request")).state, "pending");
  } finally { f.close(); }
});

test("submission intent is single-use and survives reopening the queue", () => {
  const f = fixture();
  try {
    f.queue.create(request());
    f.queue.claim("request-one", "controller");
    f.queue.submit("request-one", "controller");
    const restarted = new AppHandoffQueue(f.dir);
    assert.equal(restarted.read("request-one").submissionAttempted, true);
    assert.throws(() => restarted.submit("request-one", "controller"), /never resend/);
    assert.equal(restarted.cancel("request-one").state, "cancel_requested");
  } finally { f.close(); }
});
