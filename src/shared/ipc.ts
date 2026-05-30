import net from "node:net";

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
const IPC_RUN_REQUEST_TIMEOUT_MS = 1_800_000;

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
