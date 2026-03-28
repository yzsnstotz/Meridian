import assert from "node:assert/strict";
import { test } from "node:test";

import { A2A_TASK_STATES, hubResultStatusToTaskState, outputDeltaToA2A } from "./a2a-adapter";

test("A2A adapter exports the canonical task states", () => {
  assert.deepEqual(A2A_TASK_STATES, ["working", "completed", "failed"]);
});

test("outputDeltaToA2A maps text deltas to working messages", () => {
  const message = outputDeltaToA2A({
    traceId: "trace-1",
    phase: "working",
    text: "partial",
    final: false
  });

  assert.deepEqual(message, {
    taskId: "trace-1",
    taskState: "working",
    parts: [{ type: "text", text: "partial" }]
  });
});

test("outputDeltaToA2A maps result data to completed messages", () => {
  const message = outputDeltaToA2A({
    traceId: "trace-2",
    phase: "result",
    data: { usage: 42 },
    final: true
  });

  assert.deepEqual(message, {
    taskId: "trace-2",
    taskState: "completed",
    parts: [{ type: "data", data: { usage: 42 } }]
  });
});

test("outputDeltaToA2A includes both text and data when both exist", () => {
  const message = outputDeltaToA2A({
    traceId: "trace-3",
    phase: "error",
    text: "failed",
    data: { code: "E_FAIL" },
    final: true
  });

  assert.deepEqual(message, {
    taskId: "trace-3",
    taskState: "failed",
    parts: [
      { type: "text", text: "failed" },
      { type: "data", data: { code: "E_FAIL" } }
    ]
  });
});

test("hubResultStatusToTaskState follows the PRD mapping table", () => {
  assert.equal(hubResultStatusToTaskState("partial"), "working");
  assert.equal(hubResultStatusToTaskState("success"), "completed");
  assert.equal(hubResultStatusToTaskState("error"), "failed");
  assert.equal(hubResultStatusToTaskState("timeout"), "failed");
});
