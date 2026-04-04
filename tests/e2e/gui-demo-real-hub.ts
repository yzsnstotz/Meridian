/**
 * GUI demo against a real Meridian Hub (no mocked launchDispatcher / no stub sendToHub).
 *
 * Prerequisites:
 * - Meridian Hub is running and listening on HUB_SOCKET_PATH (default: /tmp/hub-socks/hub-core.sock).
 * - Run from repo root, or cwd will be set to Meridian-roles root so spawn --spawn-dir matches this repo.
 *
 * Usage:
 *   HUB_SOCKET_PATH=/path/to/hub.sock npx tsx tests/e2e/gui-demo-real-hub.ts
 *
 * Optional:
 *   GUI_DEMO_TIMEOUT_MS=900000   (default 15 minutes)
 */

import * as fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const HUB_SOCKET_CANDIDATES = ["/tmp/hub-socks/hub-core.sock", "/tmp/hub-core.sock"];
const DEFAULT_TIMEOUT_MS = 900_000;

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected an ephemeral port"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function resolveHubSocketPath(): Promise<string> {
  if (process.env.HUB_SOCKET_PATH?.trim()) {
    const hubPath = process.env.HUB_SOCKET_PATH.trim();
    try {
      await fs.access(hubPath);
      return hubPath;
    } catch {
      throw new Error(
        `HUB_SOCKET_PATH is set but not accessible: ${hubPath}. Start Meridian Hub or fix the path.`
      );
    }
  }

  for (const candidate of HUB_SOCKET_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }

  throw new Error(
    `Meridian Hub socket not found. Tried: ${HUB_SOCKET_CANDIDATES.join(", ")}. Start a real Hub or set HUB_SOCKET_PATH.`
  );
}

async function resetDemoFixture(args: {
  dispatchPlanPath: string;
  inputPath: string;
  step1Path: string;
  finalPath: string;
  auditPath: string;
  recordPath: string;
  sidecarPath: string;
}): Promise<void> {
  await fs.mkdir(path.dirname(args.dispatchPlanPath), { recursive: true });

  const dispatchPlan = await fs.readFile(args.dispatchPlanPath, "utf8");
  const resetPlan = dispatchPlan
    .split(/\r?\n/)
    .map((line) => {
      if (line.includes("| A-01 |") || line.includes("| B-01 |")) {
        return line.replace(/\|\s*[⬜🔄✅⛔]\s*\|/, "| ⬜ |");
      }
      return line;
    })
    .join("\n");

  await fs.writeFile(args.dispatchPlanPath, resetPlan, "utf8");
  await fs.writeFile(args.inputPath, "hello-from-gui-demo\n", "utf8");
  await fs.writeFile(args.auditPath, "", "utf8");
  await fs.rm(args.step1Path, { force: true }).catch(() => undefined);
  await fs.rm(args.finalPath, { force: true }).catch(() => undefined);
  await fs.rm(args.recordPath, { force: true }).catch(() => undefined);
  await fs.rm(args.sidecarPath, { force: true }).catch(() => undefined);
}

async function waitForDemoOutputs(args: {
  finalPath: string;
  sidecarPath: string;
  dispatchPlanPath: string;
  deadlineMs: number;
}): Promise<void> {
  const deadline = Date.now() + args.deadlineMs;

  while (Date.now() < deadline) {
    try {
      const [finalRaw, sidecarRaw, planRaw] = await Promise.all([
        fs.readFile(args.finalPath, "utf8"),
        fs.readFile(args.sidecarPath, "utf8"),
        fs.readFile(args.dispatchPlanPath, "utf8")
      ]);

      if (
        finalRaw.trim().length > 0
        && sidecarRaw.includes('"workers": {}')
        && planRaw.includes("| ✅ | 1 | A-01 |")
        && planRaw.includes("| ✅ | 2 | B-01 |")
      ) {
        return;
      }
    } catch {
      // Continue polling while the dispatcher flow writes its artifacts.
    }

    await sleep(500);
  }

  throw new Error(
    `Timed out after ${args.deadlineMs}ms waiting for terminal gui-demo outputs (real agents may be slow or blocked).`
  );
}

async function main(): Promise<void> {
  const hubSocketPath = await resolveHubSocketPath();
  process.env.HUB_SOCKET_PATH = hubSocketPath;

  const repoRoot = path.resolve(__dirname, "../..");
  process.chdir(repoRoot);

  if (!process.env.STATE_FILE_PATH) {
    process.env.STATE_FILE_PATH = path.join(tmpdir(), `meridian-roles-gui-demo-${randomUUID().slice(0, 8)}.json`);
  }

  if (!process.env.ROLES_SOCKET_PATH) {
    process.env.ROLES_SOCKET_PATH = path.join(tmpdir(), `meridian-roles-gui-demo-${randomUUID().slice(0, 8)}.sock`);
  }

  process.env.GUI_LISTEN_HOST = process.env.GUI_LISTEN_HOST ?? "127.0.0.1";
  if (!process.env.GUI_PORT) {
    process.env.GUI_PORT = String(await getFreePort());
  }

  const timeoutMs = Number(process.env.GUI_DEMO_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("Invalid GUI_DEMO_TIMEOUT_MS");
  }

  const fixtureDir = path.join(repoRoot, "test", "gui-demo");
  const dispatchPlanPath = path.join(fixtureDir, "dispatch_plan.md");
  const commandFilePath = path.join(fixtureDir, "agent_dispatch_command.md");
  const inputPath = path.join(fixtureDir, "input.txt");
  const step1Path = path.join(fixtureDir, "step1.txt");
  const finalPath = path.join(fixtureDir, "final.txt");
  const auditPath = path.join(fixtureDir, "audit.txt");
  const recordPath = path.join(fixtureDir, "record.md");
  const sidecarPath = path.join(fixtureDir, "dispatch_threads.json");

  await resetDemoFixture({
    dispatchPlanPath,
    inputPath,
    step1Path,
    finalPath,
    auditPath,
    recordPath,
    sidecarPath
  });

  const { startMeridianRolesService } = await import("../../src/index");
  const service = await startMeridianRolesService();
  const baseUrl = `http://127.0.0.1:${process.env.GUI_PORT}`;

  console.log(`[gui-demo-real-hub] Repo cwd: ${repoRoot}`);
  console.log(`[gui-demo-real-hub] Hub socket: ${hubSocketPath}`);
  console.log(`[gui-demo-real-hub] GUI: ${baseUrl}`);

  const startBody = {
    thread_id: `agent-dispatcher-gui-demo-real-${randomUUID().slice(0, 8)}`,
    dispatch_plan_path: dispatchPlanPath,
    command_file_path: commandFilePath,
    user_reply_channels: [{ channel: "web", chat_id: "web:gui-demo-real" }],
    agent_type: "codex",
    mode: "pane_bridge",
    kill_policy: "always"
  };

  const response = await fetch(`${baseUrl}/api/agent-dispatcher/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(startBody)
  });

  if (!response.ok) {
    await service.close();
    throw new Error(`POST /api/agent-dispatcher/start failed: HTTP ${response.status} ${await response.text()}`);
  }

  const started = await response.json() as { dispatcher_id: string; dispatcher_thread_id: string };
  console.log(`[gui-demo-real-hub] dispatcher_id: ${started.dispatcher_id}`);
  console.log(`[gui-demo-real-hub] dispatcher_thread_id: ${started.dispatcher_thread_id}`);

  try {
    await waitForDemoOutputs({
      finalPath,
      sidecarPath,
      dispatchPlanPath,
      deadlineMs: timeoutMs
    });
  } catch (error) {
    console.error("[gui-demo-real-hub] Waiting for outputs failed:", error);
    throw error;
  }

  const detailResponse = await fetch(`${baseUrl}/api/role/${encodeURIComponent(started.dispatcher_id)}`);
  if (!detailResponse.ok) {
    throw new Error(`GET /api/role failed: HTTP ${detailResponse.status}`);
  }

  const detail = await detailResponse.json() as {
    dispatcher_thread_id?: string;
    session_log?: string[];
  };

  const [step1, final, auditRaw, sidecarRaw, planRaw] = await Promise.all([
    fs.readFile(step1Path, "utf8"),
    fs.readFile(finalPath, "utf8"),
    fs.readFile(auditPath, "utf8"),
    fs.readFile(sidecarPath, "utf8"),
    fs.readFile(dispatchPlanPath, "utf8")
  ]);

  await fs.writeFile(recordPath, [
    "# Agent Dispatcher GUI Demo Record (real Hub)",
    "",
    `Dispatcher id: ${started.dispatcher_id}`,
    `Dispatcher thread: ${started.dispatcher_thread_id}`,
    "",
    "## Role detail (attach-aware)",
    "",
    `- dispatcher_thread_id: ${detail.dispatcher_thread_id ?? ""}`,
    `- session_log lines: ${detail.session_log?.length ?? 0}`,
    "",
    "## step1.txt",
    "```",
    step1.trimEnd(),
    "```",
    "",
    "## final.txt",
    "```",
    final.trimEnd(),
    "```",
    "",
    "## audit.txt",
    "```",
    auditRaw.trimEnd(),
    "```",
    "",
    "## dispatch_threads.json",
    "```json",
    sidecarRaw.trimEnd(),
    "```",
    "",
    "## dispatch_plan.md",
    "```md",
    planRaw.trimEnd(),
    "```"
  ].join("\n"), "utf8");

  console.log(`[gui-demo-real-hub] DONE. Record: ${recordPath}`);
  console.log(`[gui-demo-real-hub] session_log lines: ${detail.session_log?.length ?? 0}`);

  await service.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
