import net from "node:net";

const IPC_SEND_TIMEOUT_MS = 5000;
// Long-running pane_bridge providers such as Gemini can legitimately exceed 30s.
const IPC_REQUEST_TIMEOUT_MS = 120000;

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

export function sendIpcRequest<TPayload extends object, TResponse>(socketPath: string, payload: TPayload): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let rawResponse = "";
    const socket = net.createConnection(socketPath, () => {
      socket.write(JSON.stringify(payload));
      socket.end();
    });

    socket.setTimeout(IPC_REQUEST_TIMEOUT_MS);
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

export function readIpcMessage<T>(raw: string): T {
  return JSON.parse(raw) as T;
}
