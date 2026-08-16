import childProcess from "node:child_process";
import path from "node:path";

import { PathResolver, resolveMeridianPaths } from "@meridian/contracts";

import { isProcessAlive } from "./node-adapter";
import type { SupervisorSnapshot } from "./supervisor";
import { JsonSupervisorStateStore } from "./supervisor";

export type SupervisorControlCommand = "start" | "stop" | "status" | "doctor";

export interface SupervisorControlResult {
  ok: boolean;
  command: SupervisorControlCommand;
  running: boolean;
  snapshot: SupervisorSnapshot | null;
  issues: string[];
}

export interface SupervisorControlOptions {
  env?: NodeJS.ProcessEnv;
  daemonPath?: string;
  nodeExecutable?: string;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

export async function runSupervisorControlCommand(
  command: SupervisorControlCommand,
  options: SupervisorControlOptions = {}
): Promise<SupervisorControlResult> {
  const env = options.env ?? process.env;
  const paths = resolveMeridianPaths({ env });
  const store = new JsonSupervisorStateStore(path.join(paths.stateDir, "supervisor.json"));
  const current = store.load();
  const running = current !== null && isProcessAlive(current.supervisorPid);

  if (command === "start") {
    if (running) {
      return result(command, current, []);
    }
    new PathResolver({ env }).ensurePrivateDirectories(paths);
    const daemonPath = options.daemonPath ?? path.join(__dirname, "daemon.js");
    const child = childProcess.spawn(options.nodeExecutable ?? process.execPath, [daemonPath], {
      detached: true,
      env,
      stdio: "ignore"
    });
    child.unref();
    const snapshot = await waitForSnapshot(
      store,
      (candidate) =>
        candidate.supervisorPid === child.pid
        && Object.values(candidate.children).length > 0
        && Object.values(candidate.children).every((item) =>
          item?.status === "ready" || item?.status === "failed"),
      options.waitTimeoutMs ?? 20_000,
      options.pollIntervalMs ?? 100
    );
    const issues = supervisorIssues(snapshot, true);
    return result(command, snapshot, issues);
  }

  if (command === "stop") {
    if (!running || !current) {
      return result(command, current, []);
    }
    process.kill(current.supervisorPid, "SIGTERM");
    const snapshot = await waitForSnapshot(
      store,
      (candidate) =>
        candidate.supervisorPid === current.supervisorPid
        && Object.values(candidate.children).every((item) => item?.status === "stopped"),
      options.waitTimeoutMs ?? 10_000,
      options.pollIntervalMs ?? 100
    );
    return result(command, snapshot, []);
  }

  const snapshot = store.load();
  const issues = supervisorIssues(snapshot, command === "doctor");
  return result(command, snapshot, issues);
}

function result(
  command: SupervisorControlCommand,
  snapshot: SupervisorSnapshot | null,
  issues: string[]
): SupervisorControlResult {
  const running = snapshot !== null && isProcessAlive(snapshot.supervisorPid);
  return {
    ok: issues.length === 0 && (command === "stop" || running),
    command,
    running,
    snapshot,
    issues
  };
}

function supervisorIssues(
  snapshot: SupervisorSnapshot | null,
  requireReady: boolean
): string[] {
  if (!snapshot) {
    return ["supervisor state not found"];
  }
  const issues: string[] = [];
  if (!isProcessAlive(snapshot.supervisorPid)) {
    issues.push(`supervisor process ${snapshot.supervisorPid} is not alive`);
  }
  if (requireReady) {
    for (const id of ["runtime", "orchestrator"] as const) {
      const child = snapshot.children[id];
      if (!child) {
        issues.push(`${id} is missing`);
      } else if (child.status !== "ready") {
        issues.push(`${id} is ${child.status}${child.message ? `: ${child.message}` : ""}`);
      } else if (!isProcessAlive(child.pid)) {
        issues.push(`${id} process ${child.pid} is not alive`);
      }
    }
  }
  return issues;
}

async function waitForSnapshot(
  store: JsonSupervisorStateStore,
  predicate: (snapshot: SupervisorSnapshot) => boolean,
  timeoutMs: number,
  intervalMs: number
): Promise<SupervisorSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = store.load();
    if (snapshot && predicate(snapshot)) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const last = store.load();
  if (!last) {
    throw new Error(`supervisor did not create state within ${timeoutMs}ms`);
  }
  return last;
}
