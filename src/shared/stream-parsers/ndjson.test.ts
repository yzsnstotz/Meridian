import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNdjsonLine, splitNdjsonStream } from "./ndjson";

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const items: unknown[] = [];
  for await (const item of stream) {
    items.push(item);
  }
  return items;
}

test("parseNdjsonLine parses JSON payloads and skips empty input", () => {
  assert.deepEqual(parseNdjsonLine("{\"ok\":true}"), { ok: true });
  assert.equal(parseNdjsonLine("   "), null);
});

test("splitNdjsonStream buffers partial lines across chunks", async () => {
  async function* stream(): AsyncIterable<Buffer | string> {
    yield Buffer.from("{\"id\":1");
    yield "}\n{\"id\":2}\n";
  }

  const items = await collect(splitNdjsonStream(stream()));
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }]);
});

test("splitNdjsonStream skips empty lines and malformed JSON", async () => {
  async function* stream(): AsyncIterable<Buffer | string> {
    yield "\n";
    yield "{\"id\":1}\n";
    yield "not-json\n";
    yield "  \n";
    yield "{\"id\":2}\n";
  }

  const items = await collect(splitNdjsonStream(stream()));
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }]);
});

test("splitNdjsonStream parses a trailing unterminated final line", async () => {
  async function* stream(): AsyncIterable<Buffer | string> {
    yield "{\"tail\":true}";
  }

  const items = await collect(splitNdjsonStream(stream()));
  assert.deepEqual(items, [{ tail: true }]);
});
