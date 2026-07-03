import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type http from "node:http";
import { afterEach, test } from "node:test";

import { streamChatCompletion } from "./streaming";
import { resetCliResolverCache } from "./cli-resolver";

/**
 * A ServerResponse stand-in that throws `write EPIPE` after the Nth write to
 * simulate a client that dropped mid-stream. It also records whether an 'error'
 * listener was attached and whether end() ran.
 */
class DroppingResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  writes = 0;
  errorListeners = 0;
  headers: unknown;
  private dropAfter: number;

  constructor(dropAfter: number) {
    super();
    this.dropAfter = dropAfter;
  }
  override on(event: string, listener: (...args: unknown[]) => void): this {
    if (event === "error") this.errorListeners += 1;
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  writeHead(_status: number, headers?: unknown): this {
    this.headers = headers;
    return this;
  }
  lastChunk = "";
  write(chunk: string): boolean {
    this.lastChunk = chunk;
    this.writes += 1;
    if (this.writes > this.dropAfter) {
      const err = new Error("write EPIPE") as NodeJS.ErrnoException;
      err.code = "EPIPE";
      throw err;
    }
    return true;
  }
  end(): this {
    this.writableEnded = true;
    return this;
  }
}

const savedPath = { PATH: process.env.PATH };
afterEach(() => {
  process.env.PATH = savedPath.PATH;
  resetCliResolverCache();
});

function fakeClaudeStreamBin(): string {
  const dir = mkdtempSync(join(tmpdir(), "mgw-claude-stream-"));
  const p = join(dir, "claude");
  // Emit the stream-json result shape claude.ts expects, plus handle --version
  // so the resolver verifies this binary.
  writeFileSync(
    p,
    "#!/bin/sh\n" +
      'case "$1" in --version) echo "claude 1.0.0"; exit 0;; esac\n' +
      // A minimal assistant turn + terminal result event.
      'printf \'{"type":"assistant","message":{"content":[{"type":"text","text":"hello world"}]}}\\n\'\n' +
      'printf \'{"type":"result","result":"hello world","stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":2}}\\n\'\n',
    "utf8"
  );
  chmodSync(p, 0o755);
  return dir;
}

test("streamChatCompletion attaches an 'error' listener and survives a client drop mid-stream", async () => {
  const binDir = fakeClaudeStreamBin();
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  resetCliResolverCache();

  // Drop the client after the very first write (the role chunk), so every
  // subsequent sseChunk write throws EPIPE.
  const res = new DroppingResponse(1) as unknown as http.ServerResponse & DroppingResponse;

  // Must NOT throw — a dropped client is handled, not fatal.
  const completion = await streamChatCompletion(res, {
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });

  assert.ok((res as DroppingResponse).errorListeners >= 1, "an 'error' handler must be installed on the response");
  assert.ok(completion, "the stream promise still resolves with a completion");
});

test("streamChatCompletion returns a normal completion when the client stays connected", async () => {
  const binDir = fakeClaudeStreamBin();
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  resetCliResolverCache();

  const res = new DroppingResponse(Number.POSITIVE_INFINITY) as unknown as http.ServerResponse & DroppingResponse;
  const completion = await streamChatCompletion(res, {
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });

  assert.ok(completion);
  assert.ok(!completion?.isError, "a connected client yields a non-error completion");
  assert.equal((res as DroppingResponse).writableEnded, true, "stream ends cleanly");
});
