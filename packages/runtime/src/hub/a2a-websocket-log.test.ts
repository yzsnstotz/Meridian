import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { appendA2AWebSocketLog } from "./a2a-websocket-log";

test("appendA2AWebSocketLog writes JSONL under LOG_DIR/GUI/a2a-{threadId}.log", async () => {
  const logDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-a2a-ws-log-"));
  try {
    const line = JSON.stringify({ type: "a2a_message", taskId: "t1", taskState: "working", parts: [] });
    appendA2AWebSocketLog(logDir, "gemini_01", line);

    const expectedPath = path.join(logDir, "GUI", "a2a-gemini_01.log");
    const content = await fs.promises.readFile(expectedPath, "utf8");
    assert.equal(content.trimEnd(), line);
  } finally {
    await fs.promises.rm(logDir, { recursive: true, force: true });
  }
});

test("appendA2AWebSocketLog no-ops on empty threadId or payload", async () => {
  const logDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-a2a-ws-log-empty-"));
  try {
    appendA2AWebSocketLog(logDir, "   ", "{}");
    appendA2AWebSocketLog(logDir, "x", "");
    await assert.rejects(fs.promises.access(path.join(logDir, "GUI")));
  } finally {
    await fs.promises.rm(logDir, { recursive: true, force: true });
  }
});
