import * as fs from "node:fs/promises";
import net from "node:net";

import { ROLES_SOCKET_PATH } from "../config";
import type { Logger } from "../roles/base-role";
import { HubResultSchema, type HubResult } from "../types";

export type A2AResultHandler = (result: HubResult) => void | Promise<void>;

export interface A2AServerOptions {
  socketPath?: string;
  log?: Logger;
}

export class A2AServer {
  private readonly socketPath: string;
  private readonly log: Logger;
  private server: net.Server | null = null;

  constructor(
    private readonly onResult: A2AResultHandler,
    options: A2AServerOptions = {}
  ) {
    this.socketPath = options.socketPath ?? ROLES_SOCKET_PATH;
    this.log = options.log ?? console;
  }

  async listen(socketPath = this.socketPath): Promise<void> {
    if (this.server) {
      return;
    }

    await removeStaleSocket(socketPath);

    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let raw = "";

      socket.on("data", (chunk: string) => {
        raw += chunk;
      });

      socket.on("end", () => {
        void this.handleInbound(raw);
      });

      socket.on("error", (error) => {
        this.log.error("A2AServer socket error", {
          socketPath,
          error: asError(error).message
        });
      });
    });

    try {
      await listenOnSocket(server, socketPath);
    } catch (error) {
      if (!isEaddrInUse(error)) {
        throw error;
      }

      const removed = await removeStaleSocket(socketPath);
      if (!removed) {
        throw error;
      }

      await listenOnSocket(server, socketPath);
    }

    this.server = server;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    await fs.unlink(this.socketPath).catch(() => undefined);
  }

  private async handleInbound(raw: string): Promise<void> {
    try {
      const result = HubResultSchema.parse(JSON.parse(raw));
      await this.onResult(result);
    } catch (error) {
      this.log.error("A2AServer failed to parse inbound payload", {
        socketPath: this.socketPath,
        error: asError(error).message
      });
    }
  }
}

async function listenOnSocket(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

async function removeStaleSocket(socketPath: string): Promise<boolean> {
  const socketState = await probeSocketPath(socketPath);
  if (socketState !== "stale") {
    return socketState === "missing";
  }

  await fs.unlink(socketPath);
  return true;
}

async function probeSocketPath(socketPath: string): Promise<"active" | "stale" | "missing"> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);

    socket.once("connect", () => {
      socket.destroy();
      resolve("active");
    });

    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();

      if (error.code === "ENOENT") {
        resolve("missing");
        return;
      }

      if (error.code === "ECONNREFUSED" || error.code === "ENOTSOCK" || error.code === "EINVAL") {
        resolve("stale");
        return;
      }

      reject(error);
    });
  });
}

function isEaddrInUse(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
