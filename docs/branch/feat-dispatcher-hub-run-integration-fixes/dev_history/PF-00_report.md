# PF-00 Report

- **Worker**: `PF-00`
- **Model**: `CODEX-XHIGH`
- **Primary Branch**: `feat-dispatcher-hub-run-integration-fixes`
- **Related Repo Branch**: `feat/fix/agent-dispatcher`

## 1. Path and branch contract

- Confirmed primary repo root on disk: `/Users/yzliu/work/Meridian`
- Confirmed primary branch on disk: `feat-dispatcher-hub-run-integration-fixes`
- Confirmed related repo branch on disk: `feat/fix/agent-dispatcher`
- Confirmed related docs reference remains the explicit docs-folder path from the TaskSpec:
  - `/Users/yzliu/work/meridian/Meridian-roles/docs/branch/feat:dispatcher-ephemeral-spawn-run-kill/`
- On this machine, the TaskSpec's related repo root path `/Users/yzliu/work/meridian/Meridian-roles` resolves canonically to:
  - `/Users/yzliu/work/Meridian/Meridian-roles`
- The referenced related-repo source/test files do exist at the TaskSpec paths even though the filesystem canonicalizes the lowercase `meridian` segment to `Meridian`.

## 2. Environment contract

- Meridian `.env` exists on disk:
  - `/Users/yzliu/work/Meridian/.env`
- Meridian-roles `.env` does **not** exist on disk.
- Meridian-roles environment catalog exists on disk:
  - `/Users/yzliu/work/meridian/Meridian-roles/.env.example`
- Meridian config variable surface was validated from `/Users/yzliu/work/Meridian/src/config.ts`.
- Meridian `.env` currently defines these baseline keys:
  - `ALLOWED_USER_IDS`
  - `ANTHROPIC_API_KEY`
  - `CURSOR_API_KEY`
  - `GEMINI_API_KEY`
  - `HEARTBEAT_INTERVAL_MS`
  - `HEARTBEAT_MISSED_THRESHOLD`
  - `HUB_SOCKET_PATH`
  - `LOG_DIR`
  - `LOG_LEVEL`
  - `MERIDIAN_STATE_PATH`
  - `MONITOR_PROGRESS_TICK_MS`
  - `MONITOR_SYNC_INTERVAL_MS`
  - `MONITOR_UPDATE_DEFAULT_INTERVAL_SEC`
  - `MONITOR_UPDATE_MAX_INTERVAL_SEC`
  - `MONITOR_UPDATE_MIN_INTERVAL_SEC`
  - `NODE_ENV`
  - `OPENAI_API_KEY`
  - `PANE_BROADCAST_THROTTLE_MS`
  - `PANE_CAPTURE_INTERVAL_MS`
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_BOT_TOKENS`
  - `WEB_GUI_ENABLED`
  - `WEB_GUI_HOST`
  - `WEB_GUI_HTTPS`
  - `WEB_GUI_PORT`
  - `WEB_GUI_TOKEN`
- Meridian-roles runtime variable catalog from `/Users/yzliu/work/meridian/Meridian-roles/src/config.ts` and `.env.example` is:
  - `HUB_SOCKET_PATH`
  - `ROLES_SOCKET_PATH`
  - `GUI_PORT`
  - `GUI_LISTEN_HOST`
  - `STATE_FILE_PATH`
- Meridian-roles runtime env must continue to be supplied inline or via caller environment because there is no checked-in `.env` in that repo.

## 3. Baseline test inventory

### Commands run exactly from the TaskSpec

```bash
cd /Users/yzliu/work/Meridian
node --test --import tsx /Users/yzliu/work/Meridian/src/hub/router.test.ts
```
- **PASS** (`51` tests)

```bash
cd /Users/yzliu/work/Meridian
node --test --import tsx /Users/yzliu/work/Meridian/src/hub/instance-manager.test.ts
```
- **PASS** (`28` tests)

```bash
cd /Users/yzliu/work/Meridian
node --test --import tsx /Users/yzliu/work/Meridian/src/hub/result-sender.test.ts
```
- **PASS** (`13` tests)

```bash
cd /Users/yzliu/work/meridian/Meridian-roles
npx tsc --noEmit
```
- **PASS**

```bash
cd /Users/yzliu/work/meridian/Meridian-roles
npx vitest run \
  /Users/yzliu/work/meridian/Meridian-roles/src/roles/agent-dispatcher/__tests__/launcher.test.ts \
  /Users/yzliu/work/meridian/Meridian-roles/src/tool-gateway/tools/__tests__/spawn.test.ts \
  /Users/yzliu/work/meridian/Meridian-roles/src/tool-gateway/tools/__tests__/run.test.ts \
  /Users/yzliu/work/meridian/Meridian-roles/src/tool-gateway/tools/__tests__/update-status.test.ts \
  /Users/yzliu/work/meridian/Meridian-roles/src/server/__tests__/role-config-handlers.test.ts \
  /Users/yzliu/work/meridian/Meridian-roles/src/roles/definitions/__tests__/agent-dispatcher.test.ts \
  /Users/yzliu/work/meridian/Meridian-roles/src/roles/agent-dispatcher/__tests__/session-manager.test.ts
```
- **FAIL**
- Failure mode: `vitest` reported `No test files found`.
- Observed cwd during this run: `/Users/yzliu/work/Meridian/Meridian-roles`
- Baseline conclusion: the TaskSpec's absolute-path `vitest` invocation is not currently reliable on this machine under the canonicalized related-repo path.

### Corrected baseline run to capture actual suite drift

```bash
cd /Users/yzliu/work/meridian/Meridian-roles
npx vitest run \
  src/roles/agent-dispatcher/__tests__/launcher.test.ts \
  src/tool-gateway/tools/__tests__/spawn.test.ts \
  src/tool-gateway/tools/__tests__/run.test.ts \
  src/tool-gateway/tools/__tests__/update-status.test.ts \
  src/server/__tests__/role-config-handlers.test.ts \
  src/roles/definitions/__tests__/agent-dispatcher.test.ts \
  src/roles/agent-dispatcher/__tests__/session-manager.test.ts
```
- **FAIL** (`2` failed, `35` passed)
- Baseline drift captured:
  - `src/tool-gateway/tools/__tests__/spawn.test.ts`
    - expected spawn payload without `payload.spawn_dir`
    - actual runtime now sends `payload.spawn_dir: "/Users/yzliu/work/Meridian/Meridian-roles"`
  - `src/roles/agent-dispatcher/__tests__/launcher.test.ts`
    - expected spawn CLI args without `--spawn-dir`
    - actual runtime now adds `--spawn-dir /Users/yzliu/work/Meridian/Meridian-roles`
- This matches the TaskSpec requirement to capture current Meridian-roles unit drift instead of assuming a clean baseline.

## 4. `meridian-tool run --command <path>` payload-content baseline

- Runtime code inspection confirmed the current tool path reads the command file and forwards the file contents into Hub payload content:
  - `/Users/yzliu/work/meridian/Meridian-roles/src/tool-gateway/tools/run.ts`
  - `const commandText = await readFile(commandPath, "utf8");`
  - `sendAndWait(buildRunMessage(threadId, commandText), 0);`
  - `payload.content = command`
- This was also verified directly by instrumentation, not only by static reading.

### Direct instrumentation command

```bash
cd /Users/yzliu/work/meridian/Meridian-roles
npx vitest run src/tool-gateway/tools/__tests__/run.pf00-payload.test.ts
```
- **PASS** (`1` test)
- Instrumented proof: when the command file read returned:
  - `# Role Definition`
  - `Run PF-00`
- the `sendAndWait(...)` call was asserted to receive Hub payload content equal to that file text, not the path string `/tmp/agent_dispatch_command.md`.

## 5. Attach/detail evidence

- No GUI/detail certification was required for `PF-00`.
- No attach path was used in this worker.

## 6. Files changed

- `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dispatch_plan.md`
- `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/PF-00_report.md`

## 7. Worker disposition

- `PF-00` is complete.
- Meridian-side baseline is green on the targeted Hub suites.
- Meridian-roles baseline contains:
  - one invocation/path-contract failure in the exact TaskSpec `vitest` command
  - two real stale-expectation failures around `spawn_dir` / `--spawn-dir`
- `--command` handoff semantics are proven to send command-file contents to Hub.
