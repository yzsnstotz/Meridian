import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AppHandoffQueue } from "./codex-app-queue";
import { assertCodexAppIdentity, buildCodexAppArgs, runAppHandoff, useCodexApp } from "./codex-app-executor";

const uuid = "01a07727-ac38-7c23-8ef3-4bc90f594b9a";
test("App is the default task surface; read-only reviews and explicit CLI choice preserve CLI", () => {
  assert.equal(useCodexApp(undefined, {}), true);
  assert.equal(useCodexApp("read-only", {}), false);
  assert.equal(useCodexApp(undefined, { MERIDIAN_CODEX_EXECUTION_SURFACE: "cli" }), false);
  assert.throws(() => useCodexApp(undefined, { MERIDIAN_CODEX_EXECUTION_SURFACE: "typo" }), /surface/);
  const args = buildCodexAppArgs({ workerId: "some-caller", requestId: "trace-one", sessionId: uuid, model: "gpt-6-astra", effort: "xhigh" });
  assert.ok(args.some(arg => arg.includes("codex-app-executor")));
  assert.ok(args.includes(uuid));
});

test("App argument boundary rejects invalid policy values instead of treating them as absent", () => {
  for (const executionPolicy of [null, false, 0]) {
    assert.throws(() => buildCodexAppArgs({ requestId: "policy-invalid", workerId: "opaque",
      executionPolicy } as never), /Invalid input/);
  }
});

test("existing session is preserved and exact App result returns to the original stream", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meridian-app-executor-"));
  const queue = new AppHandoffQueue(dir);
  const events: unknown[] = [];
  try {
    await runAppHandoff({ requestId: "trace-one", workerId: "worker-one", sessionId: uuid, cwd: "/tmp", model: "gpt-6-astra", effort: "xhigh" }, "real task", {
      queue,
      emit: event => events.push(event),
      wait: async () => {
        const row = queue.read("trace-one");
        assert.equal(row.prompt, "real task");
        assert.equal(row.effort, "xhigh");
        queue.claim(row.id, "app-controller");
        queue.submit(row.id, "app-controller");
        queue.started(row.id, "app-controller", "app-turn");
        queue.complete(row.id, "app-controller", { threadId: uuid, turnId: "app-turn", status: "completed", text: "worker actual result" });
      }
    });
    assert.deepEqual(events, [
      { type: "thread.started", thread_id: uuid },
      { type: "item.completed", item: { id: "app-turn", type: "agent_message", text: "worker actual result" } },
      { type: "turn.completed" }
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a new worker waits for native App registration instead of creating an exec-classified session", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meridian-app-new-"));
  const queue = new AppHandoffQueue(dir);
  const events: unknown[] = [];
  try {
    await runAppHandoff({ requestId: "new-trace", workerId: "native-worker", cwd: "/tmp" }, "new task", {
      queue,
      emit: event => events.push(event), wait: async () => {
        assert.equal(queue.read("new-trace").threadId, undefined);
        queue.claim("new-trace", "app-controller");
        queue.submit("new-trace", "app-controller");
        queue.bindThread("new-trace", "app-controller", uuid);
        queue.started("new-trace", "app-controller", "native-turn");
        queue.complete("new-trace", "app-controller", { threadId: uuid, turnId: "native-turn", status: "completed", text: "native result" });
      }
    });
    assert.deepEqual(events[0], { type: "thread.started", thread_id: uuid });
    assert.equal(queue.read("new-trace").threadId, uuid);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("executor re-reads a bound turn after terminal reconciliation", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meridian-app-reconcile-loop-"));
  const queue = new AppHandoffQueue(dir);
  const events: unknown[] = [];
  let waits = 0;
  let reconciliations = 0;
  try {
    await runAppHandoff({ requestId: "reconcile-trace", workerId: "native-worker", cwd: "/tmp" }, "new task", {
      queue,
      emit: event => events.push(event),
      reconcile: async record => {
        if (record.state !== "started") return;
        reconciliations++;
        queue.complete(record.id, "app-controller", {
          threadId: uuid,
          turnId: "native-turn",
          status: "completed",
          text: "recovered exact final"
        });
      },
      wait: async () => {
        waits++;
        if (waits > 1) throw new Error("executor did not invoke terminal reconciliation");
        queue.claim("reconcile-trace", "app-controller");
        queue.submit("reconcile-trace", "app-controller");
        queue.bindThread("reconcile-trace", "app-controller", uuid);
        queue.started("reconcile-trace", "app-controller", "native-turn");
      }
    });
    assert.equal(reconciliations, 1);
    assert.deepEqual(events, [
      { type: "thread.started", thread_id: uuid },
      { type: "item.completed", item: { id: "native-turn", type: "agent_message", text: "recovered exact final" } },
      { type: "turn.completed" }
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart reuses durable request without another seed or App turn; failed App result fails the run", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meridian-app-resume-"));
  const queue = new AppHandoffQueue(dir);
  try {
    queue.create({ id: "trace-one", workerId: "worker-one", threadId: uuid, cwd: "/tmp", prompt: "real task" });
    queue.claim("trace-one", "app-controller");
    queue.submit("trace-one", "app-controller");
    queue.started("trace-one", "app-controller", "app-turn");
    queue.complete("trace-one", "app-controller", { threadId: uuid, turnId: "app-turn", status: "failed", text: "denied" });
    await assert.rejects(runAppHandoff({ requestId: "trace-one", workerId: "worker-one", cwd: "/tmp" }, "real task", {
      queue, emit: () => {}, wait: async () => {}
    }), /denied/);
    assert.equal(queue.list(true).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("managed credentials and custom environments never silently run as the App account", () => {
  assertCodexAppIdentity(null, {});
  const host = { credential_id: "host", provider: "codex" as const, is_host_default: true,
    codex_home: path.join(os.homedir(), ".codex"), env_overrides: {} };
  assertCodexAppIdentity(host, {});
  assert.throws(() => assertCodexAppIdentity({ ...host, is_host_default: false }, {}), /managed/);
  assert.throws(() => assertCodexAppIdentity({ ...host, env_overrides: { API_KEY: "private" } }, {}), /binding/);
  assert.throws(() => assertCodexAppIdentity(null, { CODEX_HOME: "/tmp/other-identity" }), /CODEX_HOME/);
});

test("upgrade retries do not retrofit policy into an already-submitted legacy request", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meridian-app-policy-upgrade-"));
  const queue = new AppHandoffQueue(dir);
  try {
    queue.create({ id: "legacy", workerId: "opaque-legacy", threadId: uuid, cwd: "/tmp", prompt: "original task" });
    queue.claim("legacy", "controller");
    queue.submit("legacy", "controller");
    queue.started("legacy", "controller", "original-turn");
    queue.complete("legacy", "controller", { threadId: uuid, turnId: "original-turn", status: "completed", text: "original result" });
    const events: unknown[] = [];
    await runAppHandoff({ requestId: "legacy", workerId: "opaque-legacy", sessionId: uuid, cwd: "/tmp",
      executionPolicy: { autoApprove: false, sandboxMode: "workspace-write" } }, "original task", {
      queue, emit: event => events.push(event), wait: async () => { throw new Error("must not submit again"); }
    });
    assert.equal(queue.read("legacy").executionPolicy, undefined);
    assert.equal(queue.read("legacy").turnId, "original-turn");
    assert.equal(events.length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cancellation before startup creates a terminal request without launching a turn", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meridian-app-cancel-"));
  const queue = new AppHandoffQueue(dir);
  try {
    await assert.rejects(runAppHandoff({ requestId: "cancel-early", workerId: "worker", cwd: "/tmp" }, "task", {
      queue, cancelled: () => true, emit: () => {}, wait: async () => { throw new Error("should not wait"); }
    }), /cancelled/);
    assert.equal(queue.read("cancel-early").state, "cancelled");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cancellation during an App turn keeps waiting and reserves the worker until terminal evidence", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meridian-app-cancel-live-"));
  const queue = new AppHandoffQueue(dir);
  const options = { requestId: "cancel-live", workerId: "worker", cwd: "/tmp", sessionId: uuid };
  let loops = 0;
  try {
    await assert.rejects(runAppHandoff(options, "task", {
      queue, cancelled: () => loops > 0, emit: () => {}, wait: async () => {
        loops++;
        if (loops === 1) {
          queue.claim(options.requestId, "controller");
          queue.submit(options.requestId, "controller");
          queue.started(options.requestId, "controller", "turn");
        } else {
          assert.equal(queue.read(options.requestId).state, "cancel_requested");
          assert.throws(() => queue.create({ id: "retry", workerId: "worker", cwd: "/tmp", prompt: "task" }), /active/);
          queue.complete(options.requestId, "controller", { threadId: uuid, turnId: "turn", status: "interrupted", text: "App stopped" });
        }
      }
    }), /App stopped/);
    assert.equal(loops, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SIGINT preserves the real executor process until its original App turn has stopped", async () => {
  const { spawn } = await import("node:child_process");
  const { setTimeout: delay } = await import("node:timers/promises");
  const dir = mkdtempSync(path.join(os.tmpdir(), "meridian-app-signal-"));
  const queue = new AppHandoffQueue(dir);
  const child = spawn(process.execPath, ["--import", "tsx", path.join(__dirname, "codex-app-executor.ts"),
    "--request", "signal-test", "--worker", "signal-worker", "--session", uuid], {
    env: { ...process.env, MERIDIAN_CODEX_APP_QUEUE_DIR: dir }, stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end("test task");
  try {
    for (let i = 0; i < 100 && queue.list().length === 0; i++) await delay(50);
    assert.equal(queue.list().length, 1);
    queue.claim("signal-test", "controller");
    queue.submit("signal-test", "controller");
    queue.started("signal-test", "controller", "actual-turn");
    child.kill("SIGINT");
    for (let i = 0; i < 100 && queue.read("signal-test").state !== "cancel_requested"; i++) await delay(50);
    assert.equal(queue.read("signal-test").state, "cancel_requested");
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    const exited = once(child, "exit");
    queue.complete("signal-test", "controller", { threadId: uuid, turnId: "actual-turn", status: "interrupted", text: "verified App stop" });
    const [code] = await exited;
    assert.equal(code, 1);
    assert.equal(queue.read("signal-test").state, "cancelled");
  } finally { child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});

test("source-mode executor resolves its own loader outside Meridian's dependency tree", async () => {
  const { spawn } = await import("node:child_process");
  const { setTimeout: delay } = await import("node:timers/promises");
  const dir = mkdtempSync(path.join(os.tmpdir(), "meridian-app-external-cwd-"));
  const queue = new AppHandoffQueue(dir);
  const executionPolicy = { autoApprove: false, sandboxMode: "workspace-write" as const };
  const [command, ...args] = buildCodexAppArgs({ requestId: "external-cwd", workerId: "external-worker", executionPolicy });
  const child = spawn(command, args, { cwd: os.tmpdir(), env: { ...process.env, MERIDIAN_CODEX_APP_QUEUE_DIR: dir }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end("external task");
  try {
    for (let i = 0; i < 100 && queue.list().length === 0; i++) await delay(50);
    assert.equal(realpathSync(queue.read("external-cwd").cwd), realpathSync(os.tmpdir()));
    assert.deepEqual(queue.read("external-cwd").executionPolicy, executionPolicy);
    const exited = once(child, "exit");
    child.kill("SIGINT");
    await exited;
    assert.equal(queue.read("external-cwd").state, "cancelled");
  } finally { child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});
