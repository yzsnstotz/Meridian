import assert from "node:assert/strict";
import { test } from "node:test";

import { buildGeminiSpawnArgs } from "./gemini";

test("buildGeminiSpawnArgs includes stream-json output by default", () => {
  const args = buildGeminiSpawnArgs("bridge", null, "--socket=/tmp/gemini.sock");

  assert.deepEqual(args, [
    "server",
    "--type=gemini",
    "--socket=/tmp/gemini.sock",
    "--",
    "gemini",
    "--output-format",
    "stream-json"
  ]);
});

test("buildGeminiSpawnArgs preserves model selection with stream-json output", () => {
  const args = buildGeminiSpawnArgs("bridge", null, "--socket=/tmp/gemini.sock", "gemini-2.5-pro");

  assert.deepEqual(args, [
    "server",
    "--type=gemini",
    "--socket=/tmp/gemini.sock",
    "--",
    "gemini",
    "--output-format",
    "stream-json",
    "--model",
    "gemini-2.5-pro"
  ]);
});
