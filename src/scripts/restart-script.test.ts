import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const restartScriptPath = path.resolve(process.cwd(), "user_scripts/restart.sh");
const terminateScriptPath = path.resolve(process.cwd(), "user_scripts/terminate.sh");
const rebuildRestartScriptPath = path.resolve(process.cwd(), "user_scripts/rebuild_restart.sh");

async function readRestartScript(): Promise<string> {
  return fs.readFile(restartScriptPath, "utf8");
}

async function readTerminateScript(): Promise<string> {
  return fs.readFile(terminateScriptPath, "utf8");
}

async function readRebuildRestartScript(): Promise<string> {
  return fs.readFile(rebuildRestartScriptPath, "utf8");
}

test("rebuild_restart.sh syncs to origin/main before building and always relaunches services", async () => {
  const script = await readRebuildRestartScript();

  assert.match(script, /sync_origin_main\(\)/);
  assert.match(script, /git fetch origin main --prune/);
  assert.match(script, /git merge --ff-only FETCH_HEAD/);
  assert.match(script, /MERIDIAN_REBUILD_ORIGIN_MAIN_SYNCED=1/);
  assert.match(script, /exec "\$\{ROOT_DIR\}\/user_scripts\/rebuild_restart\.sh"/);
  assert.match(script, /sync_origin_main "\$@"/);

  const syncIndex = script.indexOf('sync_origin_main "$@"');
  const buildIndex = script.indexOf('log "Building project"');
  const terminateIndex = script.indexOf('log "Terminating previous-generation services and stragglers"');
  const restartIndex = script.indexOf('log "Restarting services"');

  assert.ok(syncIndex >= 0 && syncIndex < buildIndex, "origin/main sync must happen before build");
  assert.ok(buildIndex >= 0 && buildIndex < terminateIndex, "build must complete before old services are killed");
  assert.ok(terminateIndex >= 0 && terminateIndex < restartIndex, "restart must happen after termination");
});

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

test("restart.sh resolves pm2 binary by path when not on PATH (launchd / minimal-PATH spawner)", async () => {
  const script = await readRestartScript();

  // The maintenance hub launches restart.sh under launchd with a minimal
  // PATH that omits fnm's per-shell bin dirs. `command -v pm2` returns
  // empty there, so the script must search known install locations
  // before falling through to start_with_node_dist — otherwise PM2's
  // calling-* apps keep running and the standalone set fights them for
  // ports (calling-web crash-looped 2244× on EADDRINUSE :3000 on 2026-05-19).
  assert.match(script, /find_pm2_binary\(\)/);
  assert.match(script, /\.local\/share\/fnm\/node-versions/);
  assert.match(script, /\.local\/state\/fnm_multishells/);
  assert.match(script, /\/opt\/homebrew\/bin\/pm2/);
  assert.match(script, /PM2_BIN="\$\(find_pm2_binary/);
  assert.match(script, /pm2_daemon_running/);
  assert.match(script, /WARNING: PM2 daemon is running but the pm2 binary is not on PATH/);

  // All bare `pm2 ...` invocations must go through ${PM2_BIN} so they
  // use the resolved absolute path.
  const barePm2Lines = script
    .split(/\r?\n/)
    .filter((line) => /(^|[^"$\w./-])pm2 (delete|ping|reload|restart|start|status)\b/.test(line));
  assert.deepEqual(barePm2Lines, [], `unguarded pm2 invocations found:\n${barePm2Lines.join("\n")}`);
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

test("terminate.sh resolves pm2 binary by path when not on PATH (maintenance hub / launchd spawner)", async () => {
  const script = await readTerminateScript();

  // The maintenance hub at http://127.0.0.1:8765/ spawns terminate.sh under
  // launchd with a minimal PATH that omits fnm's per-shell bin dirs.
  // `command -v pm2` returns empty there, so stop_pm2_apps used to skip the
  // `pm2 delete` call — PM2's autorestart then respawned calling-hub even
  // after kill_runtime_service SIGKILLed the PID, leaving the user's
  // "Terminate" click silently ineffective (2026-05-20 incident).
  assert.match(script, /find_pm2_binary\(\)/);
  assert.match(script, /\.local\/share\/fnm\/node-versions/);
  assert.match(script, /\/opt\/homebrew\/bin\/pm2/);
  assert.match(script, /PM2_BIN="\$\(find_pm2_binary/);
  assert.match(script, /pm2_daemon_running/);
  assert.match(script, /WARNING PM2 daemon is running but the pm2 binary is not on PATH/);

  // All bare `pm2 ...` invocations must go through ${PM2_BIN} so they
  // use the resolved absolute path — same contract as restart.sh.
  const barePm2Lines = script
    .split(/\r?\n/)
    .filter((line) => /(^|[^"$\w./-])pm2 (delete|ping|reload|restart|start|status|stop)\b/.test(line));
  assert.deepEqual(barePm2Lines, [], `unguarded pm2 invocations found:\n${barePm2Lines.join("\n")}`);
});
