import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";

import { parseDispatchPlanRows, type DispatchPlanWorkerRow } from "../../tool-gateway/tools/dispatch-status";

const DISPATCH_PLAN_FILENAME = "dispatch_plan.md";
const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";

export function loadPlanRowsByWorker(planPath: string): Map<string, DispatchPlanWorkerRow> {
  try {
    const rows = parseDispatchPlanRows(fs.readFileSync(planPath, "utf8"));
    return new Map(rows.map((row) => [row.worker_id, row]));
  } catch {
    return new Map();
  }
}

export function listActiveProcessCommands(): string[] {
  try {
    const output = execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Meridian Hub spawns the agentapi server bound to `/tmp/agentapi-<thread_id>.sock`
// when the host kernel supports the agentapi --socket flag. That socket path is
// embedded in argv, so a `ps` scan can confirm the underlying CLI is still alive
// even after the hub registry has evicted the thread (observed under sustained
// hub overload: `kill failed: No registered agent instance found for
// thread_id=codex_06` while `ps` still shows `agentapi --socket=/tmp/agentapi-codex_06.sock`).
// Returns true on a definite match. Returns false on no-match or when the ps
// probe itself fails — callers that need liveness confirmation should treat false
// as "no evidence", not "definitely gone".
export function isAgentapiProcessAliveForThread(
  threadId: string,
  activeProcessCommands?: string[]
): boolean {
  const trimmed = threadId.trim();
  if (!trimmed) {
    return false;
  }
  const commands = activeProcessCommands ?? listActiveProcessCommands();
  if (commands.length === 0) {
    return false;
  }
  const socketNeedle = `agentapi-${trimmed}.sock`;
  return commands.some((command) => command.includes(socketNeedle));
}

export function isWorkerToolProcessRunning(
  row: DispatchPlanWorkerRow | undefined,
  scanRunId: string | null,
  activeProcessCommands: string[]
): boolean {
  if (!row || activeProcessCommands.length === 0) {
    return false;
  }

  const command = extractTaskCommand(row.task);
  if (!command) {
    return false;
  }

  const signature = buildToolProcessSignature(expandScanRunId(command, scanRunId), scanRunId);
  if (!signature) {
    return false;
  }

  return activeProcessCommands.some((processCommand) => processCommandMatchesToolSignature(processCommand, signature));
}

export function resolveDispatchPlanPathFromThreadsPath(filePath: string): string {
  const directory = path.dirname(filePath);
  const defaultPlanPath = path.join(directory, DISPATCH_PLAN_FILENAME);
  if (fs.existsSync(defaultPlanPath)) {
    return defaultPlanPath;
  }

  if (path.basename(filePath) !== DISPATCH_THREADS_FILENAME) {
    return defaultPlanPath;
  }

  try {
    const candidates = fs.readdirSync(directory)
      .filter((entry) =>
        entry === DISPATCH_PLAN_FILENAME
        || entry.endsWith("_dispatch_plan.md")
        || entry.endsWith("-dispatch-plan.md")
        || entry.endsWith("-plan.md")
      )
      .sort();
    if (candidates.length === 1) {
      return path.join(directory, candidates[0]!);
    }
  } catch {
    return defaultPlanPath;
  }

  return defaultPlanPath;
}

function extractTaskCommand(task: string | null): string | null {
  if (!task) {
    return null;
  }

  const codeSpanMatch = task.match(/`([^`]+)`/);
  return (codeSpanMatch?.[1] ?? task).trim() || null;
}

function expandScanRunId(command: string, scanRunId: string | null): string {
  if (!scanRunId) {
    return command;
  }

  return command.replace(/\$\{SCAN_RUN_ID\}|\$SCAN_RUN_ID/g, scanRunId);
}

interface ToolProcessSignature {
  toolName: string;
  subcommand: string;
  scanRunId: string;
}

function buildToolProcessSignature(command: string, fallbackScanRunId: string | null): ToolProcessSignature | null {
  const tokens = splitCommandTokens(command);
  const executableIndex = findExecutableTokenIndex(tokens);
  if (executableIndex === -1) {
    return null;
  }

  const executable = tokens[executableIndex];
  if (!executable) {
    return null;
  }

  const subcommand = tokens
    .slice(executableIndex + 1)
    .find((token) => token.length > 0 && !token.startsWith("-"));
  const optionScanRunId = readOptionValue(tokens, "scan-run-id");
  const scanRunId = (optionScanRunId ?? fallbackScanRunId?.trim()) || null;
  const toolName = path.basename(executable);

  if (!toolName || !subcommand || !scanRunId) {
    return null;
  }

  return { toolName, subcommand, scanRunId };
}

function processCommandMatchesToolSignature(processCommand: string, signature: ToolProcessSignature): boolean {
  const tokens = splitCommandTokens(processCommand);
  if (!tokens.includes(signature.scanRunId)) {
    return false;
  }

  for (let index = 0; index < tokens.length; index += 1) {
    if (path.basename(tokens[index] ?? "") !== signature.toolName) {
      continue;
    }

    const followingTokens = tokens.slice(index + 1, index + 6);
    if (followingTokens.includes(signature.subcommand)) {
      return true;
    }
  }

  return false;
}

function splitCommandTokens(command: string): string[] {
  return Array.from(command.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`|[^\s]+/g))
    .map((match) => match[1] ?? match[2] ?? match[3] ?? match[0])
    .map((token) => token.trim())
    .filter(Boolean);
}

function findExecutableTokenIndex(tokens: string[]): number {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) {
    index += 1;
  }

  if (tokens[index] === "env") {
    index += 1;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) {
      index += 1;
    }
  }

  return index < tokens.length ? index : -1;
}

function readOptionValue(tokens: string[], optionName: string): string | null {
  const option = `--${optionName}`;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    if (token === option) {
      return tokens[index + 1] ?? null;
    }

    if (token.startsWith(`${option}=`)) {
      return token.slice(option.length + 1) || null;
    }
  }

  return null;
}
