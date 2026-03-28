import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { HUB_SOCKET_PATH } from "../config";
import { HubResultSchema, type HubMessage, type HubResult } from "../types";

const DEFAULT_HUB_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_SEND_AND_WAIT_TIMEOUT_MS = 60_000;
const MERIDIAN_TOOL_CHAT_ID = "service:meridian-tool";

export async function sendAndWait(
  hubMessage: Partial<HubMessage>,
  timeoutMs = DEFAULT_SEND_AND_WAIT_TIMEOUT_MS
): Promise<HubResult> {
  const traceId = hubMessage.trace_id ?? randomUUID();
  const tempSocketPath = path.join("/tmp", `meridian-tool-${randomUUID()}.sock`);
  const server = net.createServer();

  let settleResult: ((value: HubResult) => void) | null = null;
  let settleError: ((reason?: unknown) => void) | null = null;
  let timeoutHandle: NodeJS.Timeout | null = null;

  const resultPromise = new Promise<HubResult>((resolve, reject) => {
    settleResult = resolve;
    settleError = reject;
  });

  const rejectWithCleanup = (error: unknown): void => {
    if (!settleError) {
      return;
    }

    const reject = settleError;
    settleError = null;
    settleResult = null;
    reject(asError(error));
  };

  const resolveWithCleanup = (result: HubResult): void => {
    if (!settleResult) {
      return;
    }

    const resolve = settleResult;
    settleResult = null;
    settleError = null;
    resolve(result);
  };

  const handleSigint = (): void => {
    rejectWithCleanup(new Error("Tool Gateway interrupted by SIGINT"));
  };

  const handleSigterm = (): void => {
    rejectWithCleanup(new Error("Tool Gateway interrupted by SIGTERM"));
  };

  server.on("connection", (socket) => {
    socket.setEncoding("utf8");
    let rawResponse = "";

    socket.on("data", (chunk: string) => {
      rawResponse += chunk;
    });

    socket.once("end", () => {
      if (!rawResponse.trim()) {
        rejectWithCleanup(new Error("Hub callback completed without a response body"));
        return;
      }

      try {
        const result = HubResultSchema.parse(JSON.parse(rawResponse));
        if (result.trace_id !== traceId) {
          return;
        }

        resolveWithCleanup(result);
      } catch (error) {
        rejectWithCleanup(error);
      }
    });

    socket.once("error", (error) => {
      rejectWithCleanup(error);
    });
  });

  server.once("error", (error) => {
    rejectWithCleanup(error);
  });

  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  try {
    await removeSocketPath(tempSocketPath);
    await listenOnSocket(server, tempSocketPath);

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        rejectWithCleanup(new Error(`Hub timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    await sendFireAndForget(buildOutboundMessage(hubMessage, traceId, tempSocketPath), getHubSocketPath());
    return await resultPromise;
  } finally {
    process.removeListener("SIGINT", handleSigint);
    process.removeListener("SIGTERM", handleSigterm);

    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    await closeServer(server);
    await removeSocketPath(tempSocketPath);
  }
}

function buildOutboundMessage(
  hubMessage: Partial<HubMessage>,
  traceId: string,
  socketPath: string
): Partial<HubMessage> {
  return {
    ...hubMessage,
    trace_id: traceId,
    reply_channel: {
      ...hubMessage.reply_channel,
      channel: "socket",
      chat_id: hubMessage.reply_channel?.chat_id ?? MERIDIAN_TOOL_CHAT_ID,
      socket_path: socketPath
    }
  };
}

function getHubSocketPath(): string {
  return process.env.HUB_SOCKET_PATH ?? HUB_SOCKET_PATH;
}

function listenOnSocket(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(socketPath);
  });
}

function sendFireAndForget(message: Partial<HubMessage>, hubSocketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection(hubSocketPath);
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy(new Error(`Tool Gateway connect timed out after ${DEFAULT_HUB_CONNECT_TIMEOUT_MS}ms`));
    }, DEFAULT_HUB_CONNECT_TIMEOUT_MS);

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      reject(asError(error));
    };

    socket.once("connect", () => {
      if (settled) {
        return;
      }

      clearTimeout(timeout);

      try {
        socket.end(JSON.stringify(message));
        settled = true;
        resolve();
      } catch (error) {
        fail(error);
      }
    });

    socket.once("error", fail);
  });
}

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (!error || (typeof error === "object" && error !== null && "code" in error && error.code === "ERR_SERVER_NOT_RUNNING")) {
        resolve();
        return;
      }

      reject(error);
    });
  });
}

async function removeSocketPath(socketPath: string): Promise<void> {
  await fs.rm(socketPath, { force: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
