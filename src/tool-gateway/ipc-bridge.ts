import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { GUI_PORT, HUB_SOCKET_PATH } from "../config";
import { HubResultSchema, type HubMessage, type HubResult } from "../types";
import { sendViaFileRelay } from "./file-relay";

const DEFAULT_HUB_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_SEND_AND_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_HTTP_RELAY_TIMEOUT_MS = 120_000;
const MERIDIAN_TOOL_CHAT_ID = "service:meridian-tool";
const CALLBACK_SOCKET_DIR_ENV = "MERIDIAN_TOOL_SOCKET_DIR";
const HUB_RELAY_URL_ENV = "MERIDIAN_HUB_RELAY_URL";
const MERIDIAN_ROLES_REPO_ROOT = path.resolve(__dirname, "../..");
const REPO_LOCAL_CALLBACK_SOCKET_DIR = path.join(MERIDIAN_ROLES_REPO_ROOT, ".tmp");

export async function sendAndWait(
  hubMessage: Partial<HubMessage>,
  timeoutMs = DEFAULT_SEND_AND_WAIT_TIMEOUT_MS
): Promise<HubResult> {
  const traceId = hubMessage.trace_id ?? randomUUID();

  try {
    return await sendViaCallbackSocket(hubMessage, traceId, timeoutMs);
  } catch (error) {
    const resolvedError = asError(error);
    if (!isRetryableSocketPathError(resolvedError)) {
      throw resolvedError;
    }

    console.warn("Tool Gateway callback socket unavailable; falling back to inline Hub response", {
      expected_trace_id: traceId,
      error: resolvedError.message
    });

    try {
      return await sendInlineAndWait(buildInlineOutboundMessage(hubMessage, traceId), timeoutMs);
    } catch (inlineError) {
      const resolvedInlineError = asError(inlineError);
      if (!isRetryableSocketPathError(resolvedInlineError)) {
        throw resolvedInlineError;
      }

      console.warn("Tool Gateway inline Hub connect also unavailable; falling back to HTTP relay", {
        expected_trace_id: traceId,
        error: resolvedInlineError.message
      });

      try {
        return await sendViaHttpRelay(
          { ...hubMessage, trace_id: traceId },
          timeoutMs > 0 ? timeoutMs : DEFAULT_HTTP_RELAY_TIMEOUT_MS
        );
      } catch (httpError) {
        console.warn("Tool Gateway HTTP relay also unavailable; falling back to file relay", {
          expected_trace_id: traceId,
          error: asError(httpError).message
        });

        return sendViaFileRelay(
          { ...hubMessage, trace_id: traceId },
          timeoutMs > 0 ? timeoutMs : DEFAULT_HTTP_RELAY_TIMEOUT_MS
        );
      }
    }
  }
}

async function sendViaCallbackSocket(
  hubMessage: Partial<HubMessage>,
  traceId: string,
  timeoutMs: number
): Promise<HubResult> {
  let tempSocketPath: string | null = null;
  let server: net.Server | null = null;
  let handleServerError: ((error: Error) => void) | null = null;

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

  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  try {
    const binding = await bindCallbackSocket(traceId, resolveWithCleanup, rejectWithCleanup);
    server = binding.server;
    tempSocketPath = binding.socketPath;
    handleServerError = (error) => {
      rejectWithCleanup(error);
    };
    server.on("error", handleServerError);

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        rejectWithCleanup(new Error(`Hub timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    await sendFireAndForget(buildOutboundMessage(hubMessage, traceId, tempSocketPath), getHubSocketPath());
    return await resultPromise;
  } finally {
    if (server && handleServerError) {
      server.off("error", handleServerError);
    }

    process.removeListener("SIGINT", handleSigint);
    process.removeListener("SIGTERM", handleSigterm);

    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    if (server) {
      await closeServer(server);
    }
    if (tempSocketPath) {
      await removeSocketPath(tempSocketPath);
    }
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

function buildInlineOutboundMessage(hubMessage: Partial<HubMessage>, traceId: string): Partial<HubMessage> {
  return {
    ...hubMessage,
    trace_id: traceId,
    reply_channel: hubMessage.reply_channel ?? {
      channel: "web",
      chat_id: MERIDIAN_TOOL_CHAT_ID
    }
  };
}

function getHubSocketPath(): string {
  return process.env.HUB_SOCKET_PATH ?? HUB_SOCKET_PATH;
}

async function bindCallbackSocket(
  traceId: string,
  resolveWithCleanup: (result: HubResult) => void,
  rejectWithCleanup: (error: unknown) => void
): Promise<{ server: net.Server; socketPath: string }> {
  let lastError: Error | null = null;

  for (const socketPath of buildCallbackSocketPathCandidates()) {
    const server = createCallbackServer(traceId, resolveWithCleanup, rejectWithCleanup);

    try {
      await ensureSocketDirectory(socketPath);
      await removeSocketPath(socketPath);
      await listenOnSocket(server, socketPath);
      return {
        server,
        socketPath
      };
    } catch (error) {
      lastError = asError(error);
      await closeServer(server).catch(() => undefined);
      await removeSocketPath(socketPath).catch(() => undefined);

      if (!isRetryableSocketPathError(lastError)) {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error("Failed to bind Meridian tool callback socket");
}

function createCallbackServer(
  traceId: string,
  resolveWithCleanup: (result: HubResult) => void,
  rejectWithCleanup: (error: unknown) => void
): net.Server {
  const server = net.createServer();

  server.on("connection", (socket) => {
    socket.setEncoding("utf8");
    let rawResponse = "";

    socket.on("data", (chunk: string) => {
      rawResponse += chunk;
    });

    socket.once("end", () => {
      if (!rawResponse.trim()) {
        console.warn("Hub callback completed without a response body", {
          expected_trace_id: traceId
        });
        rejectWithCleanup(new Error("Hub callback completed without a response body"));
        return;
      }

      try {
        const result = HubResultSchema.parse(JSON.parse(rawResponse));
        if (result.trace_id !== traceId) {
          console.error("Hub callback trace_id mismatch", {
            expected_trace_id: traceId,
            received_trace_id: result.trace_id
          });
          return;
        }

        resolveWithCleanup(result);
      } catch (error) {
        console.warn("Hub callback body could not be parsed", {
          expected_trace_id: traceId,
          error: asError(error).message
        });
        rejectWithCleanup(error);
      }
    });

    socket.once("error", (error) => {
      rejectWithCleanup(error);
    });
  });

  return server;
}

function buildCallbackSocketPathCandidates(): string[] {
  const basename = `meridian-tool-${randomUUID()}.sock`;
  return resolveCallbackSocketDirectories().map((directory) => path.join(directory, basename));
}

function resolveCallbackSocketDirectories(): string[] {
  const configuredDirectory = process.env[CALLBACK_SOCKET_DIR_ENV]?.trim();

  // Some sandboxes block Unix socket binds under the system temp dir. Use a stable repo-local fallback
  // instead of process.cwd(), which may point at the spawned worker repo rather than meridian-roles.
  return Array.from(new Set([
    configuredDirectory ? path.resolve(configuredDirectory) : null,
    path.resolve(os.tmpdir()),
    REPO_LOCAL_CALLBACK_SOCKET_DIR
  ].filter((directory): directory is string => Boolean(directory))));
}

async function ensureSocketDirectory(socketPath: string): Promise<void> {
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
}

function listenOnSocket(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleListening = (): void => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      server.off("listening", handleListening);
      server.off("error", handleError);
    };

    server.on("listening", handleListening);
    server.on("error", handleError);
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

function sendInlineAndWait(
  message: Partial<HubMessage>,
  timeoutMs: number
): Promise<HubResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let rawResponse = "";
    let responseTimeout: NodeJS.Timeout | null = null;
    const socket = net.createConnection(getHubSocketPath());
    const connectTimeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy(new Error(`Tool Gateway connect timed out after ${DEFAULT_HUB_CONNECT_TIMEOUT_MS}ms`));
    }, DEFAULT_HUB_CONNECT_TIMEOUT_MS);

    const cleanup = (): void => {
      clearTimeout(connectTimeout);
      if (responseTimeout) {
        clearTimeout(responseTimeout);
      }
    };

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      socket.destroy();
      reject(asError(error));
    };

    const resolveResponse = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      if (!rawResponse.trim()) {
        reject(new Error("Hub request completed without a response body"));
        return;
      }

      try {
        const result = HubResultSchema.parse(JSON.parse(rawResponse));
        if (result.trace_id !== message.trace_id) {
          reject(new Error(`Hub response trace_id mismatch: expected ${message.trace_id}, received ${result.trace_id}`));
          return;
        }

        resolve(result);
      } catch (error) {
        reject(new Error(`Invalid Hub response: ${asError(error).message}`));
      }
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      rawResponse += chunk;
    });
    socket.once("connect", () => {
      if (settled) {
        return;
      }

      clearTimeout(connectTimeout);
      if (timeoutMs > 0) {
        responseTimeout = setTimeout(() => {
          fail(new Error(`Hub timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      try {
        socket.write(JSON.stringify(message));
        socket.end();
      } catch (error) {
        fail(error);
      }
    });
    socket.once("end", resolveResponse);
    socket.once("close", resolveResponse);
    socket.once("error", fail);
  });
}

function getHubRelayUrl(): string {
  const configured = process.env[HUB_RELAY_URL_ENV]?.trim();
  if (configured) {
    return configured;
  }

  return `http://127.0.0.1:${GUI_PORT}/api/hub-relay`;
}

export function sendViaHttpRelay(
  hubMessage: Partial<HubMessage>,
  timeoutMs: number
): Promise<HubResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const body = JSON.stringify(hubMessage);
    const relayUrl = new URL(getHubRelayUrl());
    const requestOptions: http.RequestOptions = {
      hostname: relayUrl.hostname,
      port: relayUrl.port,
      path: relayUrl.pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      },
      timeout: timeoutMs
    };

    const request = http.request(requestOptions, (response) => {
      let rawResponse = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        rawResponse += chunk;
      });
      response.on("end", () => {
        if (settled) {
          return;
        }

        settled = true;
        if (!rawResponse.trim()) {
          reject(new Error("HTTP relay completed without a response body"));
          return;
        }

        try {
          const result = HubResultSchema.parse(JSON.parse(rawResponse));
          resolve(result);
        } catch (error) {
          reject(new Error(`Invalid HTTP relay response: ${asError(error).message}`));
        }
      });
    });

    request.on("timeout", () => {
      if (settled) {
        return;
      }

      settled = true;
      request.destroy(new Error(`HTTP relay timed out after ${timeoutMs}ms`));
    });

    request.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(asError(error));
    });

    request.end(body);
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

function isRetryableSocketPathError(error: Error): boolean {
  const code = "code" in error ? error.code : undefined;
  const message = error.message.toUpperCase();
  return code === "EACCES"
    || code === "EADDRINUSE"
    || code === "ENOENT"
    || code === "ENOTDIR"
    || code === "ENAMETOOLONG"
    || code === "EPERM"
    || message.includes("LISTEN EPERM")
    || message.includes("LISTEN EACCES")
    || message.includes("LISTEN ENOENT")
    || message.includes("LISTEN ENOTDIR")
    || message.includes("LISTEN ENAMETOOLONG")
    || message.includes("OPERATION NOT PERMITTED")
    || message.includes("PERMISSION DENIED");
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
