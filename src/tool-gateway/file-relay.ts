import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { HUB_SOCKET_PATH } from "../config";
import { HubResultSchema, type HubMessage, type HubResult } from "../types";

const RELAY_DIR_ENV = "MERIDIAN_FILE_RELAY_DIR";
const DEFAULT_RELAY_DIR_NAME = "hub-relay";
const REQUEST_SUFFIX = ".req.json";
const RESPONSE_SUFFIX = ".res.json";
const POLL_INTERVAL_MS = 100;
const STALE_REQUEST_AGE_MS = 5 * 60 * 1000;
const HUB_CONNECT_TIMEOUT_MS = 5_000;
const HUB_RESPONSE_TIMEOUT_MS = 120_000;
const FILE_RELAY_TRANSPORT = "file-relay";

export function resolveRelayDir(): string {
  const configured = process.env[RELAY_DIR_ENV]?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  return path.join(path.resolve(os.tmpdir()), buildSharedRelayDirName(resolveHubSocketPath()));
}

// ---------------------------------------------------------------------------
// Tool side: write request file, poll for response
// ---------------------------------------------------------------------------

export async function sendViaFileRelay(
  hubMessage: Partial<HubMessage>,
  timeoutMs: number
): Promise<HubResult> {
  const relayDir = resolveRelayDir();
  const traceId = hubMessage.trace_id ?? randomUUID();
  const requestPath = path.join(relayDir, `${traceId}${REQUEST_SUFFIX}`);
  const responsePath = path.join(relayDir, `${traceId}${RESPONSE_SUFFIX}`);
  const tempRequestPath = `${requestPath}.tmp`;

  await fs.mkdir(relayDir, { recursive: true });

  // Atomic write: temp file then rename
  await fs.writeFile(tempRequestPath, JSON.stringify({ ...hubMessage, trace_id: traceId }), "utf8");
  await fs.rename(tempRequestPath, requestPath);

  const deadline = Date.now() + (timeoutMs > 0 ? timeoutMs : HUB_RESPONSE_TIMEOUT_MS);

  try {
    return await pollForResponse(responsePath, traceId, deadline);
  } finally {
    // Clean up both files
    await fs.rm(requestPath, { force: true }).catch(() => undefined);
    await fs.rm(responsePath, { force: true }).catch(() => undefined);
  }
}

async function pollForResponse(responsePath: string, traceId: string, deadline: number): Promise<HubResult> {
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(responsePath, "utf8");
      if (raw.trim()) {
        const result = HubResultSchema.parse(JSON.parse(raw));
        if (result.trace_id !== traceId) {
          throw buildRelayError(
            `File relay response trace_id mismatch: expected ${traceId}, received ${result.trace_id}`,
            traceId,
            "trace-mismatch"
          );
        }
        return result;
      }
    } catch (error) {
      if (isRelayDiagnosticError(error)) {
        throw error;
      }
      const code = "code" in (error as NodeJS.ErrnoException) ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "ENOENT") {
        throw error;
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw buildRelayError(`File relay response timed out for trace_id=${traceId}`, traceId, "timeout");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Server side: watch relay dir, forward to hub, write response
// ---------------------------------------------------------------------------

export class FileRelayWatcher {
  private readonly relayDir: string;
  private readonly hubSocketPath: string;
  private watcher: fsSync.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private processing = new Set<string>();
  private stopped = false;

  constructor(options?: { relayDir?: string; hubSocketPath?: string }) {
    this.relayDir = options?.relayDir ?? resolveRelayDir();
    this.hubSocketPath = options?.hubSocketPath ?? resolveHubSocketPath();
  }

  async start(): Promise<void> {
    await fs.mkdir(this.relayDir, { recursive: true });
    await this.cleanStaleFiles();

    try {
      this.watcher = fsSync.watch(this.relayDir, (_event, filename) => {
        if (typeof filename === "string" && filename.endsWith(REQUEST_SUFFIX)) {
          void this.processRequest(filename);
        }
      });
      this.watcher.on("error", () => {
        // fs.watch can emit errors on some platforms; fall through to poll timer
      });
    } catch {
      // fs.watch not supported or fails — rely on polling
    }

    // Polling fallback in case fs.watch events are missed
    this.pollTimer = setInterval(() => {
      void this.scanForRequests();
    }, POLL_INTERVAL_MS * 5);
    this.pollTimer.unref();

    // Process any requests that arrived before we started watching
    void this.scanForRequests();
  }

  stop(): void {
    this.stopped = true;

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async scanForRequests(): Promise<void> {
    try {
      const entries = await fs.readdir(this.relayDir);
      for (const entry of entries) {
        if (entry.endsWith(REQUEST_SUFFIX)) {
          void this.processRequest(entry);
        }
      }
    } catch {
      // Directory may not exist yet
    }
  }

  private async processRequest(filename: string): Promise<void> {
    if (this.stopped || this.processing.has(filename)) {
      return;
    }

    this.processing.add(filename);
    const requestPath = path.join(this.relayDir, filename);
    const traceId = filename.slice(0, -REQUEST_SUFFIX.length);
    const responsePath = path.join(this.relayDir, `${traceId}${RESPONSE_SUFFIX}`);
    const tempResponsePath = `${responsePath}.tmp`;

    try {
      const raw = await fs.readFile(requestPath, "utf8");
      const hubMessage = JSON.parse(raw) as Partial<HubMessage>;
      const result = await this.forwardToHub(hubMessage);

      // Atomic write: temp file then rename
      await fs.writeFile(tempResponsePath, JSON.stringify(result), "utf8");
      await fs.rename(tempResponsePath, responsePath);
    } catch (error) {
      const errorResult: HubResult = {
        trace_id: traceId,
        thread_id: "file-relay",
        source: "claude",
        status: "error",
        content: error instanceof Error ? error.message : String(error),
        attachments: [],
        timestamp: new Date().toISOString()
      };

      try {
        await fs.writeFile(tempResponsePath, JSON.stringify(errorResult), "utf8");
        await fs.rename(tempResponsePath, responsePath);
      } catch {
        // Cannot write response — tool side will time out
      }
    } finally {
      this.processing.delete(filename);
    }
  }

  private forwardToHub(hubMessage: Partial<HubMessage>): Promise<HubResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let rawResponse = "";
      let requestAccepted = false;
      const socket = net.createConnection(this.hubSocketPath);
      const connectTimeout = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        socket.destroy(new Error(`File relay hub connect timed out after ${HUB_CONNECT_TIMEOUT_MS}ms`));
      }, HUB_CONNECT_TIMEOUT_MS);

      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(connectTimeout);
        socket.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
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
        socket.setTimeout(HUB_RESPONSE_TIMEOUT_MS);

        try {
          socket.write(JSON.stringify(hubMessage));
          socket.end();
          requestAccepted = true;
        } catch (error) {
          fail(error);
        }
      });
      socket.once("timeout", () => {
        fail(buildRelayError(
          `File relay hub response timed out after ${HUB_RESPONSE_TIMEOUT_MS}ms`,
          String(hubMessage.trace_id ?? "unknown"),
          "timeout",
          requestAccepted
        ));
      });
      socket.once("error", fail);
      socket.once("close", () => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(connectTimeout);

        if (!rawResponse.trim()) {
          reject(buildRelayError(
            "File relay hub request completed without a response body",
            String(hubMessage.trace_id ?? "unknown"),
            "empty-body",
            requestAccepted
          ));
          return;
        }

        try {
          const result = HubResultSchema.parse(JSON.parse(rawResponse));
          if (hubMessage.trace_id && result.trace_id !== hubMessage.trace_id) {
            reject(buildRelayError(
              `File relay hub response trace_id mismatch: expected ${hubMessage.trace_id}, received ${result.trace_id}`,
              String(hubMessage.trace_id),
              "trace-mismatch",
              requestAccepted
            ));
            return;
          }

          resolve(result);
        } catch (error) {
          reject(buildRelayError(
            `Invalid file relay hub response: ${error instanceof Error ? error.message : String(error)}`,
            String(hubMessage.trace_id ?? "unknown"),
            "invalid-body",
            requestAccepted
          ));
        }
      });
    });
  }

  private async cleanStaleFiles(): Promise<void> {
    try {
      const entries = await fs.readdir(this.relayDir);
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.endsWith(REQUEST_SUFFIX) && !entry.endsWith(RESPONSE_SUFFIX) && !entry.endsWith(".tmp")) {
          continue;
        }

        const filePath = path.join(this.relayDir, entry);
        try {
          const stat = await fs.stat(filePath);
          if (now - stat.mtimeMs > STALE_REQUEST_AGE_MS) {
            await fs.rm(filePath, { force: true });
          }
        } catch {
          // File may have been cleaned up concurrently
        }
      }
    } catch {
      // Directory may not exist yet
    }
  }
}

function resolveHubSocketPath(): string {
  return process.env.HUB_SOCKET_PATH ?? HUB_SOCKET_PATH;
}

function buildSharedRelayDirName(hubSocketPath: string): string {
  const fingerprint = createHash("sha1")
    .update(path.resolve(hubSocketPath))
    .digest("hex")
    .slice(0, 12);

  return `${DEFAULT_RELAY_DIR_NAME}-${fingerprint}`;
}

function buildRelayError(
  baseMessage: string,
  traceId: string,
  responsePathFailure: string,
  requestAccepted = true
): Error {
  return new Error(
    `${baseMessage}; trace_id=${traceId}; transport=${FILE_RELAY_TRANSPORT}; `
    + `request_delivery=${requestAccepted ? "request-may-have-reached-hub" : "request-not-sent"}; `
    + `response_path_failure=${responsePathFailure}`
  );
}

function isRelayDiagnosticError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(`transport=${FILE_RELAY_TRANSPORT}`);
}
