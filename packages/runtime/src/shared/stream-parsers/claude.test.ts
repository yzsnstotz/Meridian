import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { createClaudeStreamParser, parseClaudeEvent } from "./claude";
import { splitNdjsonStream } from "./ndjson";

async function* emitFixtureContent(content: string): AsyncIterable<string> {
  yield content;
}

async function loadFixtureEvents(name: string): Promise<unknown[]> {
  const fixturePath = path.join(__dirname, "__fixtures__", name);
  const content = await fs.readFile(fixturePath, "utf8");
  const events: unknown[] = [];

  for await (const event of splitNdjsonStream(emitFixtureContent(content))) {
    events.push(event);
  }

  return events;
}

test("parseClaudeEvent maps fixture events to working and final deltas", async () => {
  const events = await loadFixtureEvents("claude-sample.ndjson");
  const deltas = events
    .map((event) => parseClaudeEvent(event))
    .filter((delta): delta is NonNullable<typeof delta> => delta !== null);

  assert.deepEqual(deltas, [
    {
      traceId: "a8a2f72a-1698-43d9-a2f2-f0284db30689",
      phase: "working",
      text: "Hello! How can I help you today?",
      final: false
    },
    {
      traceId: "a8a2f72a-1698-43d9-a2f2-f0284db30689",
      phase: "result",
      text: "Hello! How can I help you today?",
      data: {
        input_tokens: 2,
        output_tokens: 12
      },
      final: true
    }
  ]);
});

test("parseClaudeEvent ignores metadata and rate limit events", () => {
  assert.equal(
    parseClaudeEvent({
      type: "system",
      subtype: "init",
      session_id: "session-1"
    }),
    null
  );

  assert.equal(
    parseClaudeEvent({
      type: "rate_limit_event",
      session_id: "session-1"
    }),
    null
  );
});

test("parseClaudeEvent ignores assistant events without text blocks", () => {
  assert.equal(
    parseClaudeEvent({
      type: "assistant",
      session_id: "session-3",
      message: {
        content: [{ type: "tool_use", text: "should not be emitted" }]
      }
    }),
    null
  );
});

test("createClaudeStreamParser can reuse the init session id for later events", () => {
  const parser = createClaudeStreamParser();

  assert.equal(
    parser({
      type: "system",
      subtype: "init",
      session_id: "session-2"
    }),
    null
  );

  assert.deepEqual(
    parser({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "partial" }]
      }
    }),
    {
      traceId: "session-2",
      phase: "working",
      text: "partial",
      final: false
    }
  );
});

test("parseClaudeEvent maps error results to final error deltas", () => {
  assert.deepEqual(
    parseClaudeEvent({
      type: "result",
      session_id: "session-4",
      is_error: true,
      result: "failed"
    }),
    {
      traceId: "session-4",
      phase: "error",
      text: "failed",
      final: true
    }
  );
});
