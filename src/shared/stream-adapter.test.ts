import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { OutputDelta, StreamAdapter } from "./stream-adapter";

test("OutputDelta carries the PRD stream contract shape", async () => {
  const delta: OutputDelta = {
    traceId: randomUUID(),
    spanId: randomUUID(),
    phase: "working",
    text: "partial output",
    data: { tokenCount: 3 },
    final: false
  };

  const adapter: StreamAdapter = {
    supportsStream: true,
    async *stream(sessionId: string) {
      assert.equal(sessionId, "session-1");
      yield delta;
    }
  };

  const received: OutputDelta[] = [];
  for await (const item of adapter.stream("session-1")) {
    received.push(item);
  }

  assert.deepEqual(received, [delta]);
});
