import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const restartScriptPath = path.resolve(process.cwd(), "user_scripts/restart.sh");
const terminateScriptPath = path.resolve(process.cwd(), "user_scripts/terminate.sh");

async function readRestartScript(): Promise<string> {
  return fs.readFile(restartScriptPath, "utf8");
}

async function readTerminateScript(): Promise<string> {
  return fs.readFile(terminateScriptPath, "utf8");
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

test("restart.sh preserves persisted hub state unless reset-state is explicit", async () => {
  const script = await readRestartScript();

  assert.match(script, /RESET_STATE=0/);
  assert.match(script, /--reset-state/);
  assert.match(script, /LEGACY_MERIDIAN_STATE_PATH/);
  assert.match(script, /Migrating legacy temp hub state/);
  assert.match(script, /Preserving persisted hub state/);
  assert.match(script, /Resetting persisted hub state/);
  assert.doesNotMatch(script, /rm -f "\$\{MERIDIAN_STATE_PATH\}" >\/dev\/null 2>&1 \|\| true\nfi\n\nif start_with_pm2/);
});

test("terminate.sh stops Meridian and meridian-roles without starting services", async () => {
  const script = await readTerminateScript();

  assert.match(script, /stop_meridian_roles/);
  assert.match(script, /kill_runtime_service "hub"/);
  assert.match(script, /kill_runtime_service "web-gui"/);
  assert.doesNotMatch(script, /start_with_pm2/);
  assert.doesNotMatch(script, /start_with_npm/);
});

test("terminate.sh preserves persisted hub state unless reset-state is explicit", async () => {
  const script = await readTerminateScript();

  assert.match(script, /RESET_STATE=0/);
  assert.match(script, /--reset-state/);
  assert.match(script, /LEGACY_MERIDIAN_STATE_PATH/);
  assert.match(script, /preserve persisted hub state/);
  assert.match(script, /reset persisted hub state/);
});
