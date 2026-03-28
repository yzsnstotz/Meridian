import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";

import { OUTPUT_PHASES, streamFromSpawn, type OutputDelta, type StreamAdapter } from "./stream-adapter";

test("stream adapter exports the canonical output phases", () => {
  assert.deepEqual(OUTPUT_PHASES, ["working", "result", "error"]);
});

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

test("streamFromSpawn parses stdout into deltas and skips null parser results", async () => {
  const stdout = Readable.from(['{"trace":"trace-1","text":"hello"}\n{"ignore":true}\n']);
  const parser = (event: unknown): OutputDelta | null => {
    const record = event as { trace?: string; text?: string; ignore?: boolean };
    if (record.ignore) {
      return null;
    }
    return {
      traceId: record.trace ?? "trace-1",
      phase: "working",
      text: record.text,
      final: false
    };
  };

  const deltas: OutputDelta[] = [];
  for await (const delta of streamFromSpawn(stdout, parser)) {
    deltas.push(delta);
  }

  assert.deepEqual(deltas, [
    {
      traceId: "trace-1",
      phase: "working",
      text: "hello",
      final: false
    }
  ]);
});

test("streamFromSpawn emits a recoverable error delta when stdout iteration throws", async () => {
  const stdout = Readable.from(
    (async function* () {
      yield Buffer.from('{"trace":"trace-2","text":"partial"}\n');
      throw new Error("broken pipe");
    })()
  );
  const parser = (event: unknown): OutputDelta | null => {
    const record = event as { trace?: string; text?: string };
    return {
      traceId: record.trace ?? "trace-2",
      phase: "working",
      text: record.text,
      final: false
    };
  };

  const deltas: OutputDelta[] = [];
  for await (const delta of streamFromSpawn(stdout, parser)) {
    deltas.push(delta);
  }

  assert.deepEqual(deltas, [
    {
      traceId: "trace-2",
      phase: "working",
      text: "partial",
      final: false
    },
    {
      traceId: "trace-2",
      phase: "error",
      text: "broken pipe",
      data: {
        type: "stream_error",
        recoverable: true
      },
      final: true
    }
  ]);
});
