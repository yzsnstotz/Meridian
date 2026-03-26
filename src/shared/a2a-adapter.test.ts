import assert from "node:assert/strict";
import { test } from "node:test";

import { A2AAdapter, hubResultStatusToTaskState, outputDeltaToA2A } from "./a2a-adapter";

test("outputDeltaToA2A maps working text deltas to A2A messages", () => {
  const message = outputDeltaToA2A({
    traceId: "trace-1",
    phase: "working",
    text: "partial output",
    final: false
  });

  assert.deepEqual(message, {
    taskId: "trace-1",
    taskState: "working",
    parts: [{ type: "text", text: "partial output" }]
  });
});

test("outputDeltaToA2A maps result data deltas to completed A2A messages", () => {
  const payload = { summary: "done" };
  const message = outputDeltaToA2A({
    traceId: "trace-2",
    phase: "result",
    data: payload,
    final: true
  });

  assert.deepEqual(message, {
    taskId: "trace-2",
    taskState: "completed",
    parts: [{ type: "data", data: payload }]
  });
});

test("outputDeltaToA2A preserves both text and data parts for failed deltas", () => {
  const payload = { code: "E_FAIL" };
  const message = outputDeltaToA2A({
    traceId: "trace-3",
    phase: "error",
    text: "request failed",
    data: payload,
    final: true
  });

  assert.deepEqual(message, {
    taskId: "trace-3",
    taskState: "failed",
    parts: [
      { type: "text", text: "request failed" },
      { type: "data", data: payload }
    ]
  });
});

test("outputDeltaToA2A returns an empty parts array when no payload fields are present", () => {
  const message = outputDeltaToA2A({
    traceId: "trace-4",
    phase: "working",
    final: false
  });

  assert.deepEqual(message, {
    taskId: "trace-4",
    taskState: "working",
    parts: []
  });
});

test("hubResultStatusToTaskState maps all HubResult statuses to A2A task states", () => {
  assert.equal(hubResultStatusToTaskState("partial"), "working");
  assert.equal(hubResultStatusToTaskState("success"), "completed");
  assert.equal(hubResultStatusToTaskState("error"), "failed");
  assert.equal(hubResultStatusToTaskState("timeout"), "failed");
});

test("A2AAdapter exposes the conversion helpers as instance methods", () => {
  const adapter = new A2AAdapter();

  assert.equal(adapter.hubResultStatusToTaskState("success"), "completed");
  assert.deepEqual(
    adapter.outputDeltaToA2A({
      traceId: "trace-5",
      phase: "result",
      text: "done",
      final: true
    }),
    {
      taskId: "trace-5",
      taskState: "completed",
      parts: [{ type: "text", text: "done" }]
    }
  );
});
