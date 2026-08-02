import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IPC_SEND_TIMEOUT_MS = 5000;
// Long-running providers such as Gemini can legitimately exceed 30s.
const IPC_REQUEST_TIMEOUT_MS = 120000;
// /api/run can take much longer than the default IPC timeout: stream retries
// (up to 3 × codex exec attempts) plus waitForAgentReply (600 × 500ms = 5 min).
// For the post-agentapi streaming-bridge path (codex/claude/gemini), the
// only thing the hub waits on is the spawned provider exiting — and claude
// opus driving a composed skill like `$bug-fix` (`$investigate` +
// `$taskspec` + `$dispatch`) routinely runs 8-20 min before exit. The
// previous 7-min cap caused those runs to fail-with-orphan on the web
// side even after the hub completed them. Pick a value that fits the
// slowest realistic opus skill turn (verified ADS bug-fix rounds at
// ~12-18 min) with headroom; 30 min is the operational ceiling agreed
// with the ADS team. If a skill genuinely needs longer, prefer breaking
// it into multiple `run` turns rather than bumping this further.
// Default unchanged at 30 min — the operational ceiling agreed with the ADS
// team. Prefer splitting a skill into multiple `run` turns; raise this only
// with evidence that a single turn is genuinely atomic (e.g. a real-binary
// gate that must provision 14 tools over the network before it can assert).
//
// Resolution order, evaluated PER CALL so it can be changed WITHOUT restarting
// the hub:
//   1. process.env.MERIDIAN_IPC_RUN_TIMEOUT_MS      (needs a restart to change)
//   2. "ipcRunRequestTimeoutMs" in the runtime config file
//      (MERIDIAN_RUNTIME_CONFIG, default ~/.meridian/runtime.json)
//      -> edit the file, next run picks it up immediately
//   3. DEFAULT_IPC_RUN_REQUEST_TIMEOUT_MS
// Invalid or non-positive values are ignored and fall through, so a malformed
// file can never disable the timeout.
export const DEFAULT_IPC_RUN_REQUEST_TIMEOUT_MS = 1_800_000;

function runtimeConfigPath(): string {
  const override = (process.env.MERIDIAN_RUNTIME_CONFIG ?? "").trim();
  if (override) return override;
  return path.join(os.homedir(), ".meridian", "runtime.json");
}

let cachedConfig: { mtimeMs: number; value: number | null } | null = null;

function positiveNumber(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function timeoutFromRuntimeConfig(): number | null {
  const file = runtimeConfigPath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    cachedConfig = null;
    return null;
  }
  if (cachedConfig && cachedConfig.mtimeMs === mtimeMs) return cachedConfig.value;
  let value: number | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    value = positiveNumber(parsed?.ipcRunRequestTimeoutMs);
  } catch {
    value = null;
  }
  cachedConfig = { mtimeMs, value };
  return value;
}

export function getIpcRunRequestTimeoutMs(): number {
  return (
    positiveNumber(process.env.MERIDIAN_IPC_RUN_TIMEOUT_MS) ??
    timeoutFromRuntimeConfig() ??
    DEFAULT_IPC_RUN_REQUEST_TIMEOUT_MS
  );
}

/** @deprecated load-time snapshot; prefer getIpcRunRequestTimeoutMs(). */
const IPC_RUN_REQUEST_TIMEOUT_MS = getIpcRunRequestTimeoutMs();

export function sendIpcMessage<T extends object>(socketPath: string, payload: T): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection(socketPath);
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy(new Error(`IPC send connect timed out after ${IPC_SEND_TIMEOUT_MS}ms`));
    }, IPC_SEND_TIMEOUT_MS);

    const onError = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    socket.once("connect", () => {
      if (settled) {
        return;
      }
      clearTimeout(timeout);
      try {
        socket.end(JSON.stringify(payload));
        settled = true;
        resolve();
      } catch (error) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    socket.on("error", onError);
  });
}

export function sendIpcRequest<TPayload extends object, TResponse>(
  socketPath: string,
  payload: TPayload,
  timeoutMs: number = IPC_REQUEST_TIMEOUT_MS
): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let rawResponse = "";
    const socket = net.createConnection(socketPath, () => {
      socket.write(JSON.stringify(payload));
      socket.end();
    });

    socket.setTimeout(timeoutMs);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      rawResponse += chunk;
    });
    socket.on("timeout", () => {
      socket.destroy(new Error(`IPC request timed out after ${IPC_REQUEST_TIMEOUT_MS}ms`));
    });
    socket.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
    socket.on("close", () => {
      if (settled) {
        return;
      }
      settled = true;
      if (!rawResponse.trim()) {
        reject(new Error("IPC request completed without response body"));
        return;
      }
      try {
        resolve(JSON.parse(rawResponse) as TResponse);
      } catch (error) {
        reject(new Error(`Invalid IPC response payload: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

export { IPC_RUN_REQUEST_TIMEOUT_MS };

export function readIpcMessage<T>(raw: string): T {
  return JSON.parse(raw) as T;
}
