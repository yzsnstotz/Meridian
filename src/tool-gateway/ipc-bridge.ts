import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
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
type TransportName = "callback-socket" | "inline" | "http-relay" | "file-relay";

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

    logTransportFallback("Tool Gateway callback socket unavailable; falling back to inline Hub response", {
      traceId,
      transport: "callback-socket",
      nextTransport: "inline",
      error: resolvedError,
      requestAccepted: false
    });

    try {
      return await sendInlineAndWait(buildInlineOutboundMessage(hubMessage, traceId), timeoutMs);
    } catch (inlineError) {
      const resolvedInlineError = asError(inlineError);
      if (!isRetryableSocketPathError(resolvedInlineError)) {
        throw resolvedInlineError;
      }

      logTransportFallback("Tool Gateway inline Hub connect also unavailable; falling back to HTTP relay", {
        traceId,
        transport: "inline",
        nextTransport: "http-relay",
        error: resolvedInlineError,
        requestAccepted: false
      });

      try {
        return await sendViaHttpRelay(
          { ...hubMessage, trace_id: traceId },
          timeoutMs > 0 ? timeoutMs : DEFAULT_HTTP_RELAY_TIMEOUT_MS
        );
      } catch (httpError) {
        logTransportFallback("Tool Gateway HTTP relay also unavailable; falling back to file relay", {
          traceId,
          transport: "http-relay",
          nextTransport: "file-relay",
          error: asError(httpError),
          requestAccepted: false
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
  let requestAccepted = false;

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
        rejectWithCleanup(buildReplyPathError({
          baseMessage: `Hub timeout after ${timeoutMs}ms`,
          traceId,
          transport: "callback-socket",
          requestAccepted,
          responsePathFailure: "timeout"
        }));
      }, timeoutMs);
    }

    await sendFireAndForget(buildOutboundMessage(hubMessage, traceId, tempSocketPath), getHubSocketPath());
    requestAccepted = true;
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
  const logReplyPathIssue = (
    message: string,
    responsePathFailure: string,
    error?: Error
  ): void => {
    console.warn(message, {
      trace_id: traceId,
      transport: "callback-socket",
      request_delivery: describeRequestDelivery(true),
      response_path_failure: responsePathFailure,
      error: error?.message
    });
  };

  server.on("connection", (socket) => {
    socket.setEncoding("utf8");
    let rawResponse = "";

    socket.on("data", (chunk: string) => {
      rawResponse += chunk;
    });

    socket.once("end", () => {
      if (!rawResponse.trim()) {
        logReplyPathIssue("Hub callback completed without a response body", "empty-body");
        rejectWithCleanup(buildReplyPathError({
          baseMessage: "Hub callback completed without a response body",
          traceId,
          transport: "callback-socket",
          requestAccepted: true,
          responsePathFailure: "empty-body"
        }));
        return;
      }

      try {
        const result = HubResultSchema.parse(JSON.parse(rawResponse));
        if (result.trace_id !== traceId) {
          console.error("Hub callback trace_id mismatch", {
            trace_id: traceId,
            transport: "callback-socket",
            received_trace_id: result.trace_id
          });
          return;
        }

        resolveWithCleanup(result);
      } catch (error) {
        const resolvedError = asError(error);
        logReplyPathIssue("Hub callback body could not be parsed", "invalid-body", resolvedError);
        rejectWithCleanup(buildReplyPathError({
          baseMessage: `Hub callback body could not be parsed: ${resolvedError.message}`,
          traceId,
          transport: "callback-socket",
          requestAccepted: true,
          responsePathFailure: "invalid-body"
        }));
      }
    });

    socket.once("error", (error) => {
      rejectWithCleanup(error);
    });
  });

  return server;
}

function buildCallbackSocketPathCandidates(): string[] {
  const basename = `mt-${randomUUID().replaceAll("-", "").slice(0, 16)}.sock`;
  return resolveCallbackSocketDirectories().map((directory) => path.join(directory, basename));
}

function resolveCallbackSocketDirectories(): string[] {
  const configuredDirectory = process.env[CALLBACK_SOCKET_DIR_ENV]?.trim();
  const workspaceSocketDir = path.join(resolveProcessWorkspaceRoot(), ".tmp");

  // Worker sandboxes often allow writes in their current workspace even when the Meridian repo itself
  // is read-only. Prefer the active workspace first, then fall back to broader temp locations.
  return Array.from(new Set([
    configuredDirectory ? path.resolve(configuredDirectory) : null,
    workspaceSocketDir,
    path.resolve(os.tmpdir()),
    REPO_LOCAL_CALLBACK_SOCKET_DIR
  ].filter((directory): directory is string => Boolean(directory))));
}

function resolveProcessWorkspaceRoot(): string {
  const currentDirectory = path.resolve(process.cwd());
  return findNearestGitRoot(currentDirectory) ?? currentDirectory;
}

function findNearestGitRoot(startDirectory: string): string | null {
  let current = path.resolve(startDirectory);

  while (true) {
    const gitPath = path.join(current, ".git");
    try {
      const stat = fsSync.statSync(gitPath);
      if (stat.isDirectory() || stat.isFile()) {
        return current;
      }
    } catch {
      // Continue walking upward until the filesystem root.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
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
    let requestAccepted = false;
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
        reject(buildReplyPathError({
          baseMessage: "Hub request completed without a response body",
          traceId: String(message.trace_id ?? "unknown"),
          transport: "inline",
          requestAccepted,
          responsePathFailure: "empty-body"
        }));
        return;
      }

      try {
        const result = HubResultSchema.parse(JSON.parse(rawResponse));
        if (result.trace_id !== message.trace_id) {
          reject(buildReplyPathError({
            baseMessage: `Hub response trace_id mismatch: expected ${message.trace_id}, received ${result.trace_id}`,
            traceId: String(message.trace_id ?? "unknown"),
            transport: "inline",
            requestAccepted,
            responsePathFailure: "trace-mismatch"
          }));
          return;
        }

        resolve(result);
      } catch (error) {
        reject(buildReplyPathError({
          baseMessage: `Invalid Hub response: ${asError(error).message}`,
          traceId: String(message.trace_id ?? "unknown"),
          transport: "inline",
          requestAccepted,
          responsePathFailure: "invalid-body"
        }));
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
          fail(buildReplyPathError({
            baseMessage: `Hub timeout after ${timeoutMs}ms`,
            traceId: String(message.trace_id ?? "unknown"),
            transport: "inline",
            requestAccepted,
            responsePathFailure: "timeout"
          }));
        }, timeoutMs);
      }

      try {
        socket.write(JSON.stringify(message));
        socket.end();
        requestAccepted = true;
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
          reject(buildReplyPathError({
            baseMessage: "HTTP relay completed without a response body",
            traceId: String(hubMessage.trace_id ?? "unknown"),
            transport: "http-relay",
            requestAccepted: true,
            responsePathFailure: "empty-body"
          }));
          return;
        }

        try {
          const result = HubResultSchema.parse(JSON.parse(rawResponse));
          resolve(result);
        } catch (error) {
          reject(buildReplyPathError({
            baseMessage: `Invalid HTTP relay response: ${asError(error).message}`,
            traceId: String(hubMessage.trace_id ?? "unknown"),
            transport: "http-relay",
            requestAccepted: true,
            responsePathFailure: "invalid-body"
          }));
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

function logTransportFallback(
  message: string,
  context: {
    traceId: string;
    transport: TransportName;
    nextTransport: TransportName;
    error: Error;
    requestAccepted: boolean;
  }
): void {
  console.warn(message, {
    trace_id: context.traceId,
    transport: context.transport,
    next_transport: context.nextTransport,
    request_delivery: describeRequestDelivery(context.requestAccepted),
    response_path_failure: classifyResponsePathFailure(context.error),
    error: context.error.message
  });
}

function buildReplyPathError(args: {
  baseMessage: string;
  traceId: string;
  transport: TransportName;
  requestAccepted: boolean;
  responsePathFailure: string;
}): Error {
  return new Error(
    `${args.baseMessage}; trace_id=${args.traceId}; transport=${args.transport}; `
    + `request_delivery=${describeRequestDelivery(args.requestAccepted)}; `
    + `response_path_failure=${args.responsePathFailure}`
  );
}

function describeRequestDelivery(requestAccepted: boolean): string {
  return requestAccepted ? "request-may-have-reached-hub" : "request-not-sent";
}

function classifyResponsePathFailure(error: Error): string {
  const message = error.message.toLowerCase();
  if (message.includes("timeout")) {
    return "timeout";
  }
  if (message.includes("without a response body")) {
    return "empty-body";
  }
  if (message.includes("trace_id mismatch")) {
    return "trace-mismatch";
  }
  if (message.includes("invalid")) {
    return "invalid-body";
  }

  return "transport-unavailable";
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
