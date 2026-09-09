import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test, type TestContext } from "node:test";
import { AppHandoffQueue } from "../agents/codex-app-queue";
import { runAppHandoff } from "../agents/codex-app-executor";
import type { HubMessage } from "../types";
import { InstanceRegistry } from "./registry";
import { OutputBus } from "./output-bus";
import { HubRouter } from "./router";
import { buildPersistedHubState, loadPersistedHubState, savePersistedHubState } from "./state-store";

const nativeThread = "01a07727-ac38-7c23-8ef3-4bc90f594b9a";
const errorText = "Provider denied this request";

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meridian-native-terminal-"));
  const previousQueue = process.env.MERIDIAN_CODEX_APP_QUEUE_DIR;
  const previousSurface = process.env.MERIDIAN_CODEX_EXECUTION_SURFACE;
  process.env.MERIDIAN_CODEX_APP_QUEUE_DIR = path.join(dir, "queue");
  process.env.MERIDIAN_CODEX_EXECUTION_SURFACE = "app";
  t.after(() => {
    if (previousQueue === undefined) delete process.env.MERIDIAN_CODEX_APP_QUEUE_DIR;
    else process.env.MERIDIAN_CODEX_APP_QUEUE_DIR = previousQueue;
    if (previousSurface === undefined) delete process.env.MERIDIAN_CODEX_EXECUTION_SURFACE;
    else process.env.MERIDIAN_CODEX_EXECUTION_SURFACE = previousSurface;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, queue: new AppHandoffQueue(), statePath: path.join(dir, "state.json") };
}

function message(workerId: string, traceId = randomUUID(), intent: HubMessage["intent"] = "run"): HubMessage {
  return { trace_id: traceId, thread_id: workerId, actor_id: "opaque-actor", target: workerId, intent,
    payload: { content: "Original task", attachments: [] }, mode: "bridge",
    caller: { caller_id: workerId, caller_label: "Independent caller" },
    reply_channel: { channel: "telegram", chat_id: "100" } };
}

function register(registry: InstanceRegistry, workerId: string, status: "idle" | "running" = "idle") {
  registry.register({ thread_id: workerId, agent_type: "codex", mode: "bridge", pid: 0,
    status, supportsStream: true, codexSessionId: nativeThread, created_at: new Date().toISOString() });
}

function manager(registry: InstanceRegistry) {
  return {
    getAttachedThread: () => null,
    getThreadAttachment: () => ({ sessions: [], interface_id: null }),
    snapshotState: () => ({ instances: registry.list(), session_bindings: {} }),
    rehydrateFromState: async () => ({ restored_thread_ids: [], pruned_thread_ids: [] }),
    status: async (id: string) => ({ instance: registry.get(id), agent_status: { status: registry.get(id)?.status } })
  };
}

function failRequest(queue: AppHandoffQueue, workerId: string, requestId: string, cwd: string, status: "failed" | "interrupted" = "failed") {
  queue.create({ id: requestId, workerId, threadId: nativeThread, cwd, prompt: "Original task" });
  queue.claim(requestId, "controller");
  queue.submit(requestId, "controller");
  queue.started(requestId, "controller", "exact-turn");
  return queue.complete(requestId, "controller", {
    threadId: nativeThread, turnId: "exact-turn", status, text: errorText
  });
}

function closedChild() {
  return Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null,
    stderr: Readable.from([]), kill: () => true });
}

test("durable native failure produces one Hub error and persisted final for unrelated callers without retries", async t => {
  const f = fixture(t);
  for (const workerId of ["opaque-7e0ca", "independent-91bd2"]) {
    const registry = new InstanceRegistry();
    register(registry, workerId);
    const traceId = randomUUID();
    let attempts = 0;
    const router = new HubRouter(registry, { statePath: f.statePath, instanceManager: {
      ...manager(registry),
      spawnStreamAgent: () => {
        attempts++;
        failRequest(f.queue, workerId, traceId, f.dir);
        return { process: closedChild(), stdout: Readable.from((async function* () {
          const events: unknown[] = [];
          await runAppHandoff({ requestId: traceId, workerId, cwd: f.dir }, "Original task", {
            queue: f.queue, emit: event => events.push(event), wait: async () => assert.fail("terminal must not wait")
          });
          for (const event of events) yield JSON.stringify(event) + "\n";
        })()) };
      }
    } as never });
    const result = await router.route(message(workerId, traceId));
    assert.equal(result.status, "error");
    assert.equal(result.run_state, "completed");
    assert.equal(result.content, errorText);
    assert.equal(attempts, 1);
    assert.equal(f.queue.read(traceId).history.filter(entry => entry.state === "started").length, 1);
    assert.equal(registry.get(workerId)?.status, "idle");
    const finals = router.getConversationHistoryForThread(workerId).filter(entry => entry.event_kind === "final_reply");
    assert.equal(finals.length, 1);
    assert.equal(finals[0]?.status, "error");
    assert.equal(finals[0]?.run_state, "completed");
    const persisted = loadPersistedHubState(f.statePath, new Date().toISOString());
    assert.equal(persisted.conversation_history?.[workerId]?.at(-1)?.status, "error");
    const restored = new HubRouter(registry, { statePath: f.statePath, instanceManager: manager(registry) as never });
    await restored.initialize();
    assert.deepEqual(restored.getConversationHistoryForThread(workerId), router.getConversationHistoryForThread(workerId));
  }
});

test("history/status recover an orphaned authentic failure once at its recorded terminal timestamp", async t => {
  const f = fixture(t);
  for (const [intent, terminalStatus] of [["history", "failed"], ["status", "failed"], ["history", "interrupted"]] as const) {
    const registry = new InstanceRegistry();
    const workerId = `opaque-${intent}-${terminalStatus}`;
    register(registry, workerId, "running");
    const traceId = randomUUID();
    const record = failRequest(f.queue, workerId, traceId, f.dir, terminalStatus);
    savePersistedHubState(f.statePath, buildPersistedHubState(new Date().toISOString(), registry.list(), {}, {}, {
      [workerId]: [{ id: randomUUID(), sequence: 1, event_kind: "user_send", source: "user", content: "Original task",
        trace_id: traceId, timestamp: record.createdAt }]
    }));
    const router = new HubRouter(registry, { statePath: f.statePath, instanceManager: manager(registry) as never });
    await router.initialize();
    const queueBefore = readFileSync(path.join(f.queue.directory, `${traceId}.json`));
    await router.route(message(workerId, randomUUID(), intent));
    await router.route(message(workerId, randomUUID(), intent));
    const finals = router.getConversationHistoryForThread(workerId).filter(entry => entry.event_kind === "final_reply");
    assert.equal(finals.length, 1);
    assert.equal(finals[0]?.raw_content, errorText);
    assert.equal(finals[0]?.status, "error");
    assert.equal(finals[0]?.run_state, "completed");
    assert.equal(finals[0]?.timestamp, record.updatedAt);
    assert.equal(registry.get(workerId)?.status, "idle");
    assert.deepEqual(readFileSync(path.join(f.queue.directory, `${traceId}.json`)), queueBefore);
    assert.equal(loadPersistedHubState(f.statePath, new Date().toISOString()).conversation_history?.[workerId]?.at(-1)?.status, "error");
  }
});

test("read recovery never consumes mismatched evidence or clears a newer durable reservation", async t => {
  const f = fixture(t);
  for (const condition of ["wrong-trace", "newer-trace", "newer-reservation", "wrong-native-thread", "wrong-result-turn",
    "existing-final", "input-after-terminal", "start-after-terminal"] as const) {
    const registry = new InstanceRegistry();
    const workerId = `opaque-${condition}`;
    register(registry, workerId, "running");
    const traceId = randomUUID();
    const record = failRequest(f.queue, workerId, traceId, f.dir);
    if (condition === "wrong-result-turn") record.result!.turnId = "unrelated-turn";
    if (condition === "start-after-terminal") record.startedAt = new Date(Date.parse(record.updatedAt) + 1000).toISOString();
    if (condition === "wrong-result-turn" || condition === "start-after-terminal") {
      writeFileSync(path.join(f.queue.directory, `${traceId}.json`), JSON.stringify(record));
    }
    if (condition === "newer-reservation") f.queue.create({ id: randomUUID(), workerId, cwd: f.dir, prompt: "next task" });
    if (condition === "wrong-native-thread") registry.setCodexSessionId(workerId, "01a07727-ac96-7881-9913-ae16f1029e92");
    const history = [{ id: randomUUID(), sequence: 1, event_kind: "user_send" as const, source: "user", content: "Original task",
      trace_id: condition === "wrong-trace" ? randomUUID() : traceId,
      timestamp: condition === "input-after-terminal" ? new Date(Date.parse(record.updatedAt) + 1000).toISOString() : record.createdAt }];
    const entries = condition === "newer-trace" ? [...history, { ...history[0]!, id: randomUUID(), sequence: 2, trace_id: randomUUID() }]
      : condition === "existing-final" ? [...history, { ...history[0]!, id: randomUUID(), sequence: 2, event_kind: "final_reply" as const,
        source: "codex", content: "Already recorded final" }] : history;
    savePersistedHubState(f.statePath, buildPersistedHubState(new Date().toISOString(), registry.list(), {}, {}, { [workerId]: entries }));
    const router = new HubRouter(registry, { statePath: f.statePath, instanceManager: manager(registry) as never });
    await router.initialize();
    const before = router.getConversationHistoryForThread(workerId);
    await router.route(message(workerId, randomUUID(), "history"));
    assert.deepEqual(router.getConversationHistoryForThread(workerId), before, condition);
    assert.equal(registry.get(workerId)?.status, "running", condition);
  }
});

for (const timing of ["missing-submission", "missing-start", "input-after-submission"] as const) {
  test(`read recovery leaves ${timing} timing unresolved despite an exact failed trace`, async t => {
    const f = fixture(t);
    const registry = new InstanceRegistry();
    const workerId = `opaque-${timing}`;
    register(registry, workerId, "running");
    const traceId = randomUUID();
    const record = failRequest(f.queue, workerId, traceId, f.dir);
    let inputTimestamp = record.createdAt;
    if (timing === "missing-submission") delete record.submittedAt;
    if (timing === "missing-start") delete record.startedAt;
    if (timing === "input-after-submission") {
      const submitted = Date.parse(record.submittedAt!);
      inputTimestamp = new Date(submitted + 1000).toISOString();
      record.startedAt = new Date(submitted + 2000).toISOString();
      record.updatedAt = new Date(submitted + 3000).toISOString();
      record.history.at(-1)!.at = record.updatedAt;
    }
    writeFileSync(path.join(f.queue.directory, `${traceId}.json`), JSON.stringify(record));
    savePersistedHubState(f.statePath, buildPersistedHubState(new Date().toISOString(), registry.list(), {}, {}, {
      [workerId]: [{ id: randomUUID(), sequence: 1, event_kind: "user_send", source: "user", content: "Original task",
        trace_id: traceId, timestamp: inputTimestamp }]
    }));
    const router = new HubRouter(registry, { statePath: f.statePath, instanceManager: manager(registry) as never });
    await router.initialize();
    const before = router.getConversationHistoryForThread(workerId);
    const queueBefore = readFileSync(path.join(f.queue.directory, `${traceId}.json`));
    await router.route(message(workerId, randomUUID(), "history"));
    assert.deepEqual(router.getConversationHistoryForThread(workerId), before);
    assert.equal(registry.get(workerId)?.status, "running");
    assert.deepEqual(readFileSync(path.join(f.queue.directory, `${traceId}.json`)), queueBefore);
  });
}

test("authentic terminal failure survives a trailing transport error without retrying", async t => {
  const f = fixture(t);
  const registry = new InstanceRegistry();
  const workerId = "opaque-trailing-transport";
  register(registry, workerId);
  const traceId = randomUUID();
  let attempts = 0;
  failRequest(f.queue, workerId, traceId, f.dir);
  const router = new HubRouter(registry, { statePath: f.statePath, instanceManager: {
    ...manager(registry), spawnStreamAgent: () => {
      attempts++;
      return { process: closedChild(), stdout: Readable.from((async function* () {
        yield JSON.stringify({ type: "thread.started", thread_id: nativeThread }) + "\n";
        yield JSON.stringify({ type: "turn.failed", error: { message: errorText } }) + "\n";
        throw new Error("transport ended after terminal evidence");
      })()) };
    }
  } as never });
  const result = await router.route(message(workerId, traceId));
  assert.equal(result.status, "error");
  assert.equal(result.run_state, "completed");
  assert.equal(result.content, errorText);
  assert.equal(attempts, 1);
});

for (const sink of ["adapter", "record"] as const) test(`terminal ${sink} output failure preserves one authentic Hub error and durable history`, async t => {
  const f = fixture(t);
  const registry = new InstanceRegistry();
  const workerId = "opaque-output-delivery";
  register(registry, workerId);
  const traceId = randomUUID();
  let attempts = 0;
  let deliveries = 0;
  failRequest(f.queue, workerId, traceId, f.dir);
  const fail = (phase: string) => {
    if (phase === "error") {
      deliveries++;
      throw new Error("terminal delivery sink unavailable");
    }
  };
  const outputBus = new OutputBus(sink === "adapter"
    ? { adapterOutput: async (_traceId, _message, delta) => fail(delta.phase) }
    : { recordOutput: (_traceId, delta) => fail(delta.phase) });
  const router = new HubRouter(registry, { statePath: f.statePath, outputBus, instanceManager: {
    ...manager(registry), spawnStreamAgent: () => {
      attempts++;
      return { process: closedChild(), stdout: Readable.from([
        JSON.stringify({ type: "thread.started", thread_id: nativeThread }) + "\n",
        JSON.stringify({ type: "turn.failed", error: { message: errorText } }) + "\n"
      ]) };
    }
  } as never });
  const result = await router.route(message(workerId, traceId));
  assert.equal(result.status, "error");
  assert.equal(result.run_state, "completed");
  assert.equal(result.content, errorText);
  assert.equal(attempts, 1);
  assert.equal(deliveries, 1);
  assert.equal(router.getConversationHistoryForThread(workerId).filter(entry => entry.event_kind === "final_reply").length, 1);
  assert.equal(loadPersistedHubState(f.statePath, new Date().toISOString()).conversation_history?.[workerId]?.at(-1)?.status, "error");
});

test("ordinary recoverable transport failures still retry and return the actual success", async t => {
  const f = fixture(t);
  process.env.MERIDIAN_CODEX_EXECUTION_SURFACE = "cli";
  const registry = new InstanceRegistry();
  const workerId = "opaque-transport-retry";
  register(registry, workerId);
  let attempts = 0;
  const router = new HubRouter(registry, { statePath: f.statePath, instanceManager: {
    ...manager(registry), spawnStreamAgent: () => {
      const attempt = ++attempts;
      return { process: closedChild(), stdout: Readable.from((async function* () {
        if (attempt === 1) throw new Error("recoverable socket closure");
        yield JSON.stringify({ type: "thread.started", thread_id: nativeThread }) + "\n";
        yield JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Actual success" } }) + "\n";
        yield JSON.stringify({ type: "turn.completed" }) + "\n";
      })()) };
    }
  } as never });
  const result = await router.route(message(workerId));
  assert.equal(attempts, 2);
  assert.equal(result.status, "success");
  assert.equal(result.run_state, "completed");
  assert.equal(result.content, "Actual success");
});

test("read recovery and a finishing old stream preserve current in-memory or durable ownership", async t => {
  const f = fixture(t);
  for (const owner of ["same-stream", "new-reservation"] as const) {
    const registry = new InstanceRegistry();
    const workerId = `opaque-${owner}`;
    register(registry, workerId);
    const traceId = randomUUID();
    const stdout = new PassThrough();
    const child = closedChild();
    const router = new HubRouter(registry, { statePath: f.statePath, instanceManager: {
      ...manager(registry), spawnStreamAgent: () => {
        failRequest(f.queue, workerId, traceId, f.dir);
        return { stdout, process: child };
      }
    } as never });
    const run = router.route(message(workerId, traceId));
    await new Promise<void>(resolve => setImmediate(resolve));
    const nextId = randomUUID();
    if (owner === "new-reservation") f.queue.create({ id: nextId, workerId, cwd: f.dir, prompt: "Next task" });
    await router.route(message(workerId, randomUUID(), "history"));
    assert.equal(router.getConversationHistoryForThread(workerId).filter(entry => entry.event_kind === "final_reply").length, 0);
    assert.equal(registry.get(workerId)?.status, "running");
    stdout.end(JSON.stringify({ type: "thread.started", thread_id: nativeThread }) + "\n"
      + JSON.stringify({ type: "turn.failed", error: { message: errorText } }) + "\n");
    assert.equal((await run).status, "error");
    assert.equal(registry.get(workerId)?.status, owner === "new-reservation" ? "running" : "idle");
    if (owner === "new-reservation") assert.equal(f.queue.read(nextId).state, "pending");
  }
});
