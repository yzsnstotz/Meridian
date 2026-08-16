import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("user_scripts/rebuild_restart.sh", () => {
  it("syncs to origin/main before killing, building, and relaunching roles", async () => {
    const script = await fs.readFile(path.resolve(__dirname, "../../user_scripts/rebuild_restart.sh"), "utf8");

    expect(script).toContain("sync_origin_main()");
    expect(script).toContain("git fetch origin main --prune");
    expect(script).toContain("git merge --ff-only FETCH_HEAD");
    expect(script).toContain("MERIDIAN_ROLES_REBUILD_ORIGIN_MAIN_SYNCED=1");
    expect(script).toContain('exec "${ROOT_DIR}/user_scripts/rebuild_restart.sh"');
    expect(script).toContain('sync_origin_main "$@"');

    const syncIndex = script.indexOf('sync_origin_main "$@"');
    const killIndex = script.indexOf('kill_runtime_service "meridian-roles"');
    const buildIndex = script.indexOf('echo "Building meridian-roles..."');
    const startIndex = script.indexOf("start_service\n");

    expect(syncIndex).toBeGreaterThanOrEqual(0);
    expect(syncIndex).toBeLessThan(killIndex);
    expect(killIndex).toBeLessThan(buildIndex);
    expect(buildIndex).toBeLessThan(startIndex);
  });

  it("supports explicit reset-state for cold maintenance restarts", async () => {
    const script = await fs.readFile(path.resolve(__dirname, "../../user_scripts/rebuild_restart.sh"), "utf8");

    expect(script).toContain("RESET_STATE=0");
    expect(script).toContain("--reset-state");
    expect(script).toContain("reset_roles_state()");
    expect(script).toContain("resolve_state_file_path()");
    expect(script).toContain("STATE_FILE_PATH");
    expect(script).toContain("/tmp/meridian-roles/state.json");
    expect(script).toContain("Resetting meridian-roles state");
    expect(script).toContain("Preserving meridian-roles state");
  });

  it("provides a cold wrapper for Maintenance Hub cold reset buttons", async () => {
    const script = await fs.readFile(path.resolve(__dirname, "../../user_scripts/rebuild_restart_cold.sh"), "utf8");

    expect(script).toContain('exec "${ROOT_DIR}/user_scripts/rebuild_restart.sh" --reset-state');
  });

  it("starts roles through PM2 when available without tmux or a Hub socket health gate", async () => {
    const script = await fs.readFile(path.resolve(__dirname, "../../user_scripts/rebuild_restart.sh"), "utf8");

    expect(script).toContain("find_pm2_binary()");
    expect(script).toContain('PM2_APP_NAME="${PM2_APP_NAME:-meridian-roles}"');
    expect(script).toContain('start npm --name "${PM2_APP_NAME}" --cwd "$ROOT_DIR" -- start');
    expect(script).toContain('nohup "${START_CMD[@]}"');
    expect(script).toContain('[[ -S "${ROLES_SOCKET_PATH}" ]]');
    expect(script).not.toContain("tmux new-session");
    expect(script).not.toContain("TMUX_SESSION_FILE");
    expect(script).not.toContain("hub_socket_reachable");
    expect(script).not.toContain("ensure_meridian_hub_socket");
    expect(script).not.toContain("HUB_SOCKET_PATH=$(shell_escape");
  });

  // The Maintenance Hub "Rebuild & restart" button is the post-pull entry
  // point operators use, so the script has to refresh node_modules when the
  // lockfile drifts — not just when node_modules is missing. Before this
  // guard, PR #263 (chatter manifest) bumped ajv 6→8 in package-lock.json
  // but the operator's stale node_modules kept ajv@6 hoisted from eslint;
  // `tsc` then died on `import Ajv2020 from "ajv/dist/2020"` and rebuild
  // bailed before relaunching the service.
  it("syncs node_modules to package-lock.json before building (detects lockfile drift)", async () => {
    const script = await fs.readFile(path.resolve(__dirname, "../../user_scripts/rebuild_restart.sh"), "utf8");

    // node_modules missing: must npm ci.
    expect(script).toMatch(/if \[\[ ! -d "\$ROOT_DIR\/node_modules" \]\]; then[\s\S]{0,200}npm ci/);

    // node_modules present but package-lock.json newer than the hidden
    // node_modules/.package-lock.json: must also npm ci.
    expect(script).toContain("node_modules/.package-lock.json");
    expect(script).toMatch(/"\$ROOT_DIR\/package-lock\.json" -nt "\$ROOT_DIR\/node_modules\/\.package-lock\.json"/);
    expect(script).toMatch(/package-lock\.json is newer than node_modules\/\.package-lock\.json[\s\S]{0,200}npm ci/);
  });
});

describe("user_scripts/terminate.sh", () => {
  it("is valid bash and performs termination without rebuilding", async () => {
    const scriptPath = path.resolve(__dirname, "../../user_scripts/terminate.sh");
    const script = await fs.readFile(scriptPath, "utf8");

    expect(script).toContain("terminate");
    expect(script).toContain("find_pm2_binary()");
    expect(script).toContain('PM2_APP_NAME="${PM2_APP_NAME:-meridian-roles}"');
    expect(script).toContain('delete_pm2_service');
    expect(script).toContain("kill_repo_port_listeners");
    expect(script).not.toContain("npm run build");
  });
});

// The Maintenance Hub "Terminate" / "Rebuild & restart" buttons at
// http://127.0.0.1:8765/ spawn these scripts with launchd-minimal PATH and
// expect them to actually kill the running meridian-roles process. Before
// this fix the safety-net step was `pgrep -f
// "${ROOT_DIR}/src/index.ts|${ROOT_DIR}/dist/index.js|${ROOT_DIR}.*tsx
// src/index.ts|${ROOT_DIR}.*npm (run )?start"`. That pattern did NOT match
// relative `npm start` or `node dist/index.js`, because neither has an
// absolute ROOT_DIR in argv. Whenever the PID file pointed at a stale pid (or
// wasn't written), terminate became a no-op and rebuild's pre-launch kill was
// a no-op (the next `npm start` then hit EADDRINUSE on port 7701). Resolve by
// cwd instead of argv, mirroring Meridian's own `runtime_pids_for_service`.
describe.each([
  ["user_scripts/terminate.sh"],
  ["user_scripts/rebuild_restart.sh"]
])("%s — Maintenance Hub button contract: kill by cwd, not argv", (relPath) => {
  it("uses cwd-based filtering for relative entrypoints and drops the old pgrep alternation", async () => {
    const script = await fs.readFile(path.resolve(__dirname, "../..", relPath), "utf8");

    // Positive: the new contract — runtime_pids_for_service + process_cwd
    // gated kill, covering relative `node dist/index.js` and `npm start`.
    expect(script).toContain("runtime_pids_for_service()");
    expect(script).toContain("process_cwd");
    expect(script).toContain('kill_runtime_service "meridian-roles"');
    expect(script).toMatch(/kill_runtime_service "meridian-roles" "start"\s+"src\/index\.ts"\s+"dist\/index\.js"/);

    // Negative: the old, broken pgrep alternation is gone. Each fragment is
    // unique enough that its presence anywhere in the script signals the
    // regression has returned.
    expect(script).not.toMatch(/\$\{ROOT_DIR\}\.\*npm \(run \)\?start/);
    expect(script).not.toMatch(/\$\{ROOT_DIR\}\.\*tsx src\/index\.ts/);
    expect(script).not.toMatch(/kill_by_pattern\s+"\$\{ROOT_DIR\}/);
    expect(script).not.toContain("tmux new-session");
  });
});
