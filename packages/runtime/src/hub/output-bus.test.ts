import assert from "node:assert/strict";
import { test } from "node:test";

import { DefaultA2AAdapter } from "../shared/a2a-adapter";
import { DiffEngine } from "../shared/diff-engine";
import { OutputBus } from "./output-bus";

test("OutputBus pushDelta converts to A2A and fan-outs to both sinks", async () => {
  const adapterMessages: unknown[] = [];
  const websocketMessages: unknown[] = [];
  const records: unknown[] = [];
  const outputBus = new OutputBus({
    diffEngine: new DiffEngine(),
    a2aAdapter: new DefaultA2AAdapter(),
    adapterOutput: (_traceId, message, delta) => {
      adapterMessages.push({ message, delta });
    },
    websocketOutput: (_traceId, message, delta) => {
      websocketMessages.push({ message, delta });
    },
    recordOutput: (_traceId, delta, message) => {
      records.push({ delta, message });
    }
  });

  await outputBus.pushDelta("trace-1", {
    traceId: "stale-trace",
    phase: "working",
    text: "partial",
    final: false
  });
  // Flush microtasks queued by the fire-and-forget websocket/record sinks.
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(adapterMessages, [
    {
      message: {
        taskId: "trace-1",
        taskState: "working",
        parts: [{ type: "text", text: "partial" }]
      },
      delta: {
        traceId: "trace-1",
        phase: "working",
        text: "partial",
        final: false
      }
    }
  ]);
  assert.deepEqual(websocketMessages, adapterMessages);
  assert.deepEqual(records, adapterMessages);
});

test("OutputBus pushSnapshot diffs snapshots before dispatching", async () => {
  const messages: Array<{ traceId: string; message: unknown }> = [];
  const outputBus = new OutputBus({
    adapterOutput: (traceId, message) => {
      messages.push({ traceId, message });
    }
  });

  await outputBus.pushSnapshot("trace-1", "hello");
  await outputBus.pushSnapshot("trace-1", "hello world");
  await outputBus.pushSnapshot("trace-1", "hello world");

  assert.deepEqual(messages, [
    {
      traceId: "trace-1",
      message: {
        taskId: "trace-1",
        taskState: "working",
        parts: [{ type: "text", text: "hello" }]
      }
    },
    {
      traceId: "trace-1",
      message: {
        taskId: "trace-1",
        taskState: "working",
        parts: [{ type: "text", text: " world" }]
      }
    }
  ]);
});

test("OutputBus finalize emits a final delta and clears DiffEngine state", async () => {
  const messages: Array<{ traceId: string; message: unknown }> = [];
  const outputBus = new OutputBus({
    adapterOutput: (traceId, message) => {
      messages.push({ traceId, message });
    }
  });

  await outputBus.pushSnapshot("trace-1", "partial");
  await outputBus.finalize("trace-1", { status: "success", content: "done" });
  await outputBus.pushSnapshot("trace-1", "fresh start");

  assert.deepEqual(messages, [
    {
      traceId: "trace-1",
      message: {
        taskId: "trace-1",
        taskState: "working",
        parts: [{ type: "text", text: "partial" }]
      }
    },
    {
      traceId: "trace-1",
      message: {
        taskId: "trace-1",
        taskState: "completed",
        parts: [{ type: "text", text: "done" }]
      }
    },
    {
      traceId: "trace-1",
      message: {
        taskId: "trace-1",
        taskState: "working",
        parts: [{ type: "text", text: "fresh start" }]
      }
    }
  ]);
});

test("OutputBus finalize preserves error payloads", async () => {
  const messages: unknown[] = [];
  const outputBus = new OutputBus({
    websocketOutput: (_traceId, message) => {
      messages.push(message);
    }
  });

  await outputBus.finalize("trace-err", {
    status: "error",
    content: "boom",
    data: { code: "E_FAIL" }
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(messages, [
    {
      taskId: "trace-err",
      taskState: "failed",
      parts: [
        { type: "text", text: "boom" },
        { type: "data", data: { code: "E_FAIL" } }
      ]
    }
  ]);
});
