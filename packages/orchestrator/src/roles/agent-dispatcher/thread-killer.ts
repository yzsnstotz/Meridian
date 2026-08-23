import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

export interface KillAttachedAgentapiThreadOptions {
  logger?: Pick<typeof console, "info" | "warn" | "error">;
  sigtermWaitMs?: number;
}

export interface KillResult {
  threadId: string;
  pidsKilled: number[];
  pidsResistedTerm: number[];
  socketsRemoved: string[];
  errors: string[];
}

interface ProcInfo {
  pid: number;
  ppid: number;
  command: string;
}

const DEFAULT_SIGTERM_WAIT_MS = 2000;

export async function killAttachedAgentapiThread(
  threadId: string,
  options: KillAttachedAgentapiThreadOptions = {}
): Promise<KillResult> {
  const logger = options.logger ?? console;
  const sigtermWaitMs = options.sigtermWaitMs ?? DEFAULT_SIGTERM_WAIT_MS;
  const result: KillResult = {
    threadId,
    pidsKilled: [],
    pidsResistedTerm: [],
    socketsRemoved: [],
    errors: []
  };

  const trimmed = threadId.trim();
  if (!trimmed) {
    result.errors.push("threadId is empty");
    return result;
  }

  const socketNeedle = `agentapi-${trimmed}.sock`;
  const socketPath = `/tmp/${socketNeedle}`;

  // 1. Discover the agentapi parent processes that bind this thread's socket.
  let procs: ProcInfo[];
  try {
    procs = listProcesses();
  } catch (error) {
    result.errors.push(`ps probe failed: ${asMessage(error)}`);
    // Even with no ps data, still try to delete a stale socket so the next
    // bind doesn't fail.
    tryRemoveSocket(socketPath, result, logger);
    return result;
  }

  const owningParents = procs.filter((p) => p.command.includes(socketNeedle));
  if (owningParents.length === 0) {
    // No live agentapi for this thread, but clean any lingering socket anyway.
    tryRemoveSocket(socketPath, result, logger);
    return result;
  }

  const parentPids = new Set(owningParents.map((p) => p.pid));
  const childPids = procs
    .filter((p) => parentPids.has(p.ppid))
    .map((p) => p.pid);
  const allTargets = [...parentPids, ...childPids];

  // 2. SIGTERM the whole set.
  for (const pid of allTargets) {
    sendSignal(pid, "SIGTERM", result, logger);
  }

  // 3. Wait, then verify.
  await sleep(sigtermWaitMs);

  let aliveAfterTerm: number[] = [];
  try {
    const survivors = listProcesses();
    const survivorPids = new Set(survivors.map((p) => p.pid));
    aliveAfterTerm = allTargets.filter((pid) => survivorPids.has(pid));
  } catch (error) {
    // Ps failed during the verify pass — be conservative and SIGKILL all
    // targets blindly. SIGKILL on a dead PID is harmless.
    result.errors.push(`ps verify failed: ${asMessage(error)}`);
    aliveAfterTerm = [...allTargets];
  }

  // 4. SIGKILL stragglers.
  for (const pid of aliveAfterTerm) {
    result.pidsResistedTerm.push(pid);
    sendSignal(pid, "SIGKILL", result, logger);
  }

  result.pidsKilled = allTargets;

  // 5. Remove the canonical socket path.
  tryRemoveSocket(socketPath, result, logger);

  return result;
}

function listProcesses(): ProcInfo[] {
  const output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  return output
    .split(/\r?\n/)
    .map((line) => parseProcLine(line))
    .filter((p): p is ProcInfo => p !== null);
}

function parseProcLine(line: string): ProcInfo | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) {
    return null;
  }
  const pid = Number.parseInt(match[1] ?? "", 10);
  const ppid = Number.parseInt(match[2] ?? "", 10);
  const command = match[3] ?? "";
  if (!Number.isFinite(pid) || !Number.isFinite(ppid)) {
    return null;
  }
  return { pid, ppid, command };
}

function sendSignal(
  pid: number,
  signal: NodeJS.Signals,
  result: KillResult,
  logger: Pick<typeof console, "info" | "warn" | "error">
): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // ESRCH = process already gone. Not an error in our flow.
    if (err.code !== "ESRCH") {
      const message = `signal ${signal} pid=${pid}: ${asMessage(error)}`;
      result.errors.push(message);
      logger.warn(`thread-killer: ${message}`);
    }
  }
}

function tryRemoveSocket(
  socketPath: string,
  result: KillResult,
  logger: Pick<typeof console, "info" | "warn" | "error">
): void {
  try {
    fs.rmSync(socketPath, { force: true });
    result.socketsRemoved.push(socketPath);
  } catch (error) {
    // rmSync({ force: true }) doesn't throw for ENOENT, so any thrown error
    // here is genuine and worth surfacing.
    const message = `socket cleanup ${socketPath}: ${asMessage(error)}`;
    result.errors.push(message);
    logger.warn(`thread-killer: ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
