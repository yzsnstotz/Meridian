import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const restartScriptPath = path.resolve(process.cwd(), "user_scripts/restart.sh");

async function readRestartScript(): Promise<string> {
  return fs.readFile(restartScriptPath, "utf8");
}

test("restart.sh keep-agents PM2 mode avoids direct process kills before socket cleanup", async () => {
  const script = await readRestartScript();

  assert.match(script, /PM2_KEEP_AGENTS_MODE=0/);
  assert.match(script, /PM2 keep-agents mode detected; skipping direct Meridian process kills/);
  assert.match(script, /Skipping Hub socket cleanup because PM2 keep-agents mode manages restart ordering/);
});

test("restart.sh waits for Hub socket readiness before reporting restart completion", async () => {
  const script = await readRestartScript();

  assert.match(script, /wait_for_hub_socket\(\)/);
  assert.match(script, /Hub socket is reachable/);
  assert.match(script, /wait_for_hub_socket/);
});

test("restart.sh stops relative node dist entrypoints launched from the repo root", async () => {
  const script = await readRestartScript();

  assert.match(script, /runtime_pids_for_service\(\)/);
  assert.match(script, /process_cwd\(\)/);
  assert.match(script, /dist\/web\/server\.js/);
  assert.match(script, /src\/web\/server\.ts/);
  assert.match(script, /cwd/);
});
