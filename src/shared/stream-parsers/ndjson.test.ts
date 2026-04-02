import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNdjsonLine, splitNdjsonStream } from "./ndjson";

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const value of stream) {
    values.push(value);
  }
  return values;
}

test("parseNdjsonLine parses valid JSON objects", () => {
  assert.deepEqual(parseNdjsonLine('{ "type": "assistant", "text": "hello" }'), {
    type: "assistant",
    text: "hello"
  });
});

test("parseNdjsonLine skips empty and malformed lines", () => {
  assert.equal(parseNdjsonLine("   "), undefined);
  assert.equal(parseNdjsonLine("{not json}"), undefined);
});

test("splitNdjsonStream yields parsed objects across chunk boundaries", async () => {
  async function* streamChunks(): AsyncIterable<Buffer | string> {
    yield '{"id":1,"text":"hel';
    yield 'lo"}\n{"id":2';
    yield Buffer.from(',"text":"world"}\n');
  }

  assert.deepEqual(await collect(splitNdjsonStream(streamChunks())), [
    { id: 1, text: "hello" },
    { id: 2, text: "world" }
  ]);
});

test("splitNdjsonStream skips empty lines and malformed entries", async () => {
  async function* streamChunks(): AsyncIterable<Buffer | string> {
    yield "\n";
    yield '{"id":1}\n';
    yield "{bad json}\n";
    yield "   \n";
    yield '{"id":2}\n';
  }

  assert.deepEqual(await collect(splitNdjsonStream(streamChunks())), [{ id: 1 }, { id: 2 }]);
});

test("splitNdjsonStream parses a trailing line without a final newline", async () => {
  async function* streamChunks(): AsyncIterable<Buffer | string> {
    yield Buffer.from('{"id":3}');
  }

  assert.deepEqual(await collect(splitNdjsonStream(streamChunks())), [{ id: 3 }]);
});
