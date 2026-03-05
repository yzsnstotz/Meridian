import net from "node:net";

export function sendIpcMessage<T extends object>(socketPath: string, payload: T): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => {
      socket.write(JSON.stringify(payload));
      socket.end();
    });

    socket.on("error", reject);
    socket.on("close", () => resolve());
  });
}

export function sendIpcRequest<TPayload extends object, TResponse>(socketPath: string, payload: TPayload): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    let rawResponse = "";
    const socket = net.createConnection(socketPath, () => {
      socket.write(JSON.stringify(payload));
      socket.end();
    });

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      rawResponse += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
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
