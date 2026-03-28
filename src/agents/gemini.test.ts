import assert from "node:assert/strict";
import { test } from "node:test";

import { buildGeminiSpawnArgs, buildGeminiStreamArgs } from "./gemini";

test("buildGeminiSpawnArgs keeps the bridge launch path unchanged", () => {
  const args = buildGeminiSpawnArgs("bridge", null, "--socket=/tmp/gemini.sock", "gemini-2.5-pro");

  assert.deepEqual(args, [
    "server",
    "--type=gemini",
    "--socket=/tmp/gemini.sock",
    "--",
    "gemini",
    "--model",
    "gemini-2.5-pro"
  ]);
});

test("buildGeminiStreamArgs enables direct stream-json output", () => {
  const args = buildGeminiStreamArgs("gemini-2.5-pro");

  assert.deepEqual(args, ["gemini", "--output-format", "stream-json", "--model", "gemini-2.5-pro"]);
});
