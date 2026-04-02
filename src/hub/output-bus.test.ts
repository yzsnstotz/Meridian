import assert from "node:assert/strict";
import { test } from "node:test";

import { DefaultA2AAdapter } from "../shared/a2a-adapter";
import { DiffEngine } from "../shared/diff-engine";
import { OutputBus } from "./output-bus";

test("OutputBus pushDelta converts to A2A and fan-outs to both sinks", () => {
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

  outputBus.pushDelta("trace-1", {
    traceId: "stale-trace",
    phase: "working",
    text: "partial",
    final: false
  });

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

test("OutputBus pushSnapshot diffs snapshots before dispatching", () => {
  const messages: Array<{ traceId: string; message: unknown }> = [];
  const outputBus = new OutputBus({
    adapterOutput: (traceId, message) => {
      messages.push({ traceId, message });
    }
  });

  outputBus.pushSnapshot("trace-1", "hello");
  outputBus.pushSnapshot("trace-1", "hello world");
  outputBus.pushSnapshot("trace-1", "hello world");

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

test("OutputBus finalize emits a final delta and clears DiffEngine state", () => {
  const messages: Array<{ traceId: string; message: unknown }> = [];
  const outputBus = new OutputBus({
    adapterOutput: (traceId, message) => {
      messages.push({ traceId, message });
    }
  });

  outputBus.pushSnapshot("trace-1", "partial");
  outputBus.finalize("trace-1", { status: "success", content: "done" });
  outputBus.pushSnapshot("trace-1", "fresh start");

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

test("OutputBus finalize preserves error payloads", () => {
  const messages: unknown[] = [];
  const outputBus = new OutputBus({
    websocketOutput: (_traceId, message) => {
      messages.push(message);
    }
  });

  outputBus.finalize("trace-err", {
    status: "error",
    content: "boom",
    data: { code: "E_FAIL" }
  });

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
