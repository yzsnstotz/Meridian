import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { createGeminiStreamParser, parseGeminiEvent } from "./gemini";
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

test("createGeminiStreamParser maps fixture events to working and final deltas", async () => {
  const parser = createGeminiStreamParser();
  const events = await loadFixtureEvents("gemini-sample.ndjson");
  const deltas = events
    .map((event) => parser(event))
    .filter((delta): delta is NonNullable<typeof delta> => delta !== null);

  assert.deepEqual(deltas, [
    {
      traceId: "90918503-8e03-4289-8696-eaf65e2508b6",
      phase: "working",
      text: "Hello! How can I help you with the Meridian project today?",
      final: false
    },
    {
      traceId: "90918503-8e03-4289-8696-eaf65e2508b6",
      phase: "result",
      final: true
    }
  ]);
});

test("parseGeminiEvent ignores init and user message events", () => {
  assert.equal(
    parseGeminiEvent({
      type: "init",
      session_id: "session-1"
    }),
    null
  );

  assert.equal(
    parseGeminiEvent({
      type: "message",
      session_id: "session-1",
      role: "user",
      content: "echo"
    }),
    null
  );
});

test("parseGeminiEvent maps assistant deltas with flat string content", () => {
  assert.deepEqual(
    parseGeminiEvent({
      type: "message",
      session_id: "session-2",
      role: "assistant",
      content: "partial",
      delta: true
    }),
    {
      traceId: "session-2",
      phase: "working",
      text: "partial",
      final: false
    }
  );
});

test("createGeminiStreamParser reuses init session id for later result events", () => {
  const parser = createGeminiStreamParser();

  assert.equal(
    parser({
      type: "init",
      session_id: "session-3"
    }),
    null
  );

  assert.deepEqual(
    parser({
      type: "result",
      status: "failed"
    }),
    {
      traceId: "session-3",
      phase: "error",
      final: true
    }
  );
});
