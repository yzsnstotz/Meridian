import assert from "node:assert/strict";
import { test } from "node:test";

import { OUTPUT_PHASES, type OutputDelta, type StreamAdapter } from "./stream-adapter";

test("stream adapter exports the canonical output phases", () => {
  assert.deepEqual(OUTPUT_PHASES, ["working", "result", "error"]);
});

test("OutputDelta and StreamAdapter contracts are implementable", async () => {
  const expected: OutputDelta = {
    traceId: "trace-1",
    phase: "working",
    text: "partial",
    final: false
  };

  const adapter: StreamAdapter = {
    supportsStream: true,
    async *stream(_sessionId: string) {
      yield expected;
    }
  };

  const deltas: OutputDelta[] = [];
  for await (const delta of adapter.stream("session-1")) {
    deltas.push(delta);
  }

  assert.equal(adapter.supportsStream, true);
  assert.deepEqual(deltas, [expected]);
});
