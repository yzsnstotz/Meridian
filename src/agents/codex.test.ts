import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCodexSpawnArgs } from "./codex";

test("buildCodexSpawnArgs omits auto-approve flag by default", () => {
  const args = buildCodexSpawnArgs("bridge", null, "--socket=/tmp/codex.sock");

  assert.deepEqual(args, ["server", "--type=codex", "--socket=/tmp/codex.sock", "--", "codex"]);
  assert.equal(args.includes("--approval-policy=auto-approve"), false);
});

test("buildCodexSpawnArgs appends auto-approve flag when requested", () => {
  const args = buildCodexSpawnArgs("bridge", null, "--socket=/tmp/codex.sock", "gpt-5.4", true);

  assert.deepEqual(args, [
    "server",
    "--type=codex",
    "--socket=/tmp/codex.sock",
    "--",
    "codex",
    "--model",
    "gpt-5.4",
    "--approval-policy=auto-approve"
  ]);
});
