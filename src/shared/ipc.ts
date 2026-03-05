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

export function readIpcMessage<T>(raw: string): T {
  return JSON.parse(raw) as T;
}
