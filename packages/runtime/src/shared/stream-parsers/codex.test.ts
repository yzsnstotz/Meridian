import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { createCodexStreamParser, extractThreadId, parseCodexEvent } from "./codex";
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

test("createCodexStreamParser maps fixture events to working and final deltas", async () => {
  const parser = createCodexStreamParser();
  const events = await loadFixtureEvents("codex-sample.jsonl");
  const deltas = events
    .map((event) => parser(event))
    .filter((delta): delta is NonNullable<typeof delta> => delta !== null);

  assert.deepEqual(deltas, [
    {
      traceId: "019d26f3-8c3e-7fc2-98aa-4419e75c58e7",
      spanId: "item_0",
      phase: "working",
      text: "Hello.",
      final: false
    },
    {
      traceId: "019d26f3-8c3e-7fc2-98aa-4419e75c58e7",
      phase: "result",
      data: {
        input_tokens: 10950,
        cached_input_tokens: 9344,
        output_tokens: 61
      },
      final: true
    }
  ]);
});

test("extractThreadId only returns thread ids from thread.started events", () => {
  assert.equal(
    extractThreadId({
      type: "thread.started",
      thread_id: "thread-1"
    }),
    "thread-1"
  );

  assert.equal(
    extractThreadId({
      type: "turn.started",
      thread_id: "thread-2"
    }),
    null
  );
});

test("parseCodexEvent maps command execution start events to tool call deltas", () => {
  assert.deepEqual(
    parseCodexEvent({
      type: "item.started",
      thread_id: "thread-3",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: {
          argv: ["npm", "test"]
        }
      }
    }),
    {
      traceId: "thread-3",
      spanId: "cmd-1",
      phase: "working",
      data: {
        type: "tool_call",
        command: "npm test",
        status: "in_progress"
      },
      final: false
    }
  );
});

test("parseCodexEvent maps command execution completion events to tool result deltas", () => {
  assert.deepEqual(
    parseCodexEvent({
      type: "item.completed",
      thread_id: "thread-4",
      item: {
        id: "cmd-2",
        type: "command_execution",
        aggregated_output: "all green",
        exit_code: 0
      }
    }),
    {
      traceId: "thread-4",
      spanId: "cmd-2",
      phase: "working",
      data: {
        type: "tool_result",
        output: "all green",
        exit_code: 0
      },
      final: false
    }
  );
});

test("createCodexStreamParser reuses thread id for later lifecycle events", () => {
  const parser = createCodexStreamParser();

  assert.equal(
    parser({
      type: "thread.started",
      thread_id: "thread-5"
    }),
    null
  );

  assert.deepEqual(
    parser({
      type: "turn.completed",
      usage: {
        output_tokens: 4
      }
    }),
    {
      traceId: "thread-5",
      phase: "result",
      data: {
        output_tokens: 4
      },
      final: true
    }
  );
});

test("parseCodexEvent ignores unsupported or incomplete events", () => {
  assert.equal(
    parseCodexEvent({
      type: "item.completed",
      thread_id: "thread-6",
      item: {
        id: "tool-ignored",
        type: "tool_result",
        text: "ignored"
      }
    }),
    null
  );

  assert.equal(
    parseCodexEvent({
      type: "item.started",
      thread_id: "thread-7",
      item: {
        id: "cmd-3",
        type: "command_execution"
      }
    }),
    null
  );
});
