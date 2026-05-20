import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";

import { z } from "zod";

import { config } from "../config";
import { IpcSender, requestHubMessage, requestHubRunMessage, setCallerIdentity } from "../interface/ipc-sender";
import { BUILTIN_CALLERS, deriveBuiltinCallerKey } from "../shared/caller-bootstrap";
import { callerEnvelopeFromHttpHeaders, type WireAuth } from "../shared/caller-wire";
import type { HubRouter } from "../hub/router";
import { createLogger } from "../logger";
import { collectLogInventory } from "../log-retention";
import { cleanupStagedAttachments, stageInlineAttachments } from "../shared/attachment-transform";
import { getProviderCapabilities, listProviderCapabilities } from "../shared/provider-capabilities";
import { parseModelReference } from "../shared/model-reference";
import {
  ProviderModelCatalog as SharedProviderModelCatalog,
  type ProviderModelCatalogResult
} from "../shared/model-catalog";
import { shapeHistoryPayload } from "../shared/history-payload";
import {
  AgentTypeSchema,
  FileAttachmentSchema,
  HubMessageSchema,
  HubResultSchema,
  IntegrationProfileSchema,
  ProviderCapabilityListSchema,
  ProviderCapabilitySchema,
  ReasoningEffortSchema,
  SandboxModeSchema,
  CallerAuthoritySchema,
  ThreadProgressSnapshotSchema,
  type AgentType,
  type CallerIdentity,
  type FileAttachment,
  type HubMessage,
  type HubResult,
  type IntegrationProfile,
  type Intent,
  type ReasoningEffort,
  type SandboxMode
} from "../types";

const BUILTIN_CALLER_ID_SET = new Set<string>(BUILTIN_CALLERS.map((c) => c.caller_id));
const ADMIN_CALLER_IDENTITY: CallerIdentity = { caller_id: "meridian-admin", caller_label: "Meridian Admin" };

const sessionCookieName = "meridian_session";
const defaultStaticDir = path.join(__dirname, "public");
const packageVersion = readPackageVersion();

const runRequestBodySchema = z.object({
  thread_id: z.string().min(1).optional(),
  content: z.string().min(1, "content is required"),
  attachments: z.array(FileAttachmentSchema).default([])
});

const threadActionBodySchema = z.object({
  thread_id: z.string().min(1).optional()
});

const spawnRequestBodySchema = z.object({
  type: AgentTypeSchema.default("codex"),
  provider: AgentTypeSchema.optional(),
  mode: z.enum(["bridge", "stateless_call"]).default("bridge"),
  model_id: z.string().min(1).optional(),
  effort: ReasoningEffortSchema.optional(),
  auto_approve: z.boolean().default(true),
  integration_profile: IntegrationProfileSchema.optional(),
  sandbox_mode: SandboxModeSchema.optional(),
  /** GUI picker path or direct absolute directory override. */
  repo: z.string().optional(),
  /**
   * Absolute working directory for the new agent. Only existence/directory checks apply.
   * External integrations may send this instead of `repo`.
   */
  spawn_dir: z.string().optional(),
  /**
   * Optional credential to attach to the spawned agent. Hub validates ownership
   * and reachability; omit (or pass empty) to use the default codex login (~/.codex).
   */
  credential_id: z.string().min(1).optional()
});

const filesQuerySchema = z.object({
  thread_id: z.string().min(1),
  depth: z.coerce.number().int().min(1).max(12).default(6)
});

const fileReadQuerySchema = z.object({
  thread_id: z.string().min(1),
  path: z.string().min(1)
});

const historyQuerySchema = z.object({
  thread_id: z.string().min(1),
  // Cap kept large so the terminal page can request up to the Hub's
  // THREAD_HISTORY_LIMIT (5000) on a fresh open. Without this, long-lived
  // threads would silently truncate to the previous 200 ceiling and the
  // operator would only see the most recent slice of the conversation.
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  max_content_chars: z.coerce.number().int().min(0).max(200000).optional(),
  max_detail_chars: z.coerce.number().int().min(0).max(200000).optional(),
  max_raw_chars: z.coerce.number().int().min(0).max(200000).optional()
});

const logFileReadQuerySchema = z.object({
  path: z.string().min(1)
});

const logFileClearBodySchema = z.object({
  path: z
    .string()
    .min(1)
    .refine((value) => value.toLowerCase().endsWith(".log"), { message: "Path must be a .log file" })
});

const threadQuerySchema = z.object({
  thread_id: z.string().min(1)
});

const switchModelBodySchema = z.object({
  thread_id: z.string().min(1),
  model_id: z.string().min(1),
  effort: ReasoningEffortSchema.optional()
});

const fileWriteBodySchema = z.object({
  thread_id: z.string().min(1),
  path: z.string().min(1),
  content: z.string()
});

const terminalInputBodySchema = z.object({
  thread_id: z.string().min(1).optional(),
  content: z.string().min(1, "content is required")
});

const pushToggleBodySchema = z.object({
  thread_id: z.string().min(1).optional(),
  enabled: z.boolean().optional()
});

const autoApproveSetBodySchema = z.object({
  thread_id: z.string().min(1),
  enabled: z.boolean()
});

const autoApproveQuerySchema = z.object({
  thread_id: z.string().min(1)
});

const registerCallerBodySchema = z.object({
  caller_id: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/),
  caller_label: z.string().min(1).max(64),
  caller_authority: CallerAuthoritySchema.optional()
});

const callerAuthorityBodySchema = z.object({
  caller_authority: CallerAuthoritySchema
});

function coerceProgressSnapshot(result: HubResult) {
  if (result.progress) {
    return ThreadProgressSnapshotSchema.parse(result.progress);
  }

  const content = result.content.trim() || "Task is running...";
  const waitingForInput = /^waiting for approval/i.test(content);
  return ThreadProgressSnapshotSchema.parse({
    trace_id: result.trace_id,
    thread_id: result.thread_id,
    source: result.source,
    status: "partial",
    event_kind: waitingForInput ? "approval" : "progress",
    phase: waitingForInput ? "waiting_for_input" : "running",
    waiting_for_input: waitingForInput,
    content,
    display_text: content,
    updated_at: result.timestamp
  });
}

const captureIntervalBodySchema = z.object({
  interval_ms: z.coerce.number().int().min(2000).max(30000)
});

type RepoEntry = {
  path: string;
  kind: "file" | "dir";
};

export interface WebInterfaceLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface WebInterfaceServerOptions {
  enabled?: boolean;
  port?: number;
  listenHost?: string;
  token?: string;
  logDir?: string;
  hubSocketPath?: string;
  httpsEnabled?: boolean;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  staticDir?: string;
  requestHub?: (message: HubMessage) => Promise<HubResult>;
  requestHubRun?: (message: HubMessage) => Promise<HubResult>;
  requestHubAsCaller?: (
    message: HubMessage,
    auth: WireAuth,
    options?: { run?: boolean }
  ) => Promise<HubResult>;
  requestAdminHub?: (message: HubMessage) => Promise<HubResult>;
  providerModelCatalog?: ProviderModelCatalogLookup;
  hubSocketFactory?: (socketPath: string) => net.Socket;
  logger?: WebInterfaceLogger;
  /**
   * Test seam: when supplied, the four hub-sender slots default to in-process
   * `router.route()` calls (instead of opening real IPC sockets to a HubServer).
   * Explicit `requestHub*` overrides still win. Intended exclusively for E2E
   * tests that boot a real HubRouter alongside the web server in-process;
   * production goes through the IPC socket as before.
   */
  routerOverride?: HubRouter;
}

interface ProviderModelCatalogLookup {
  listModels(provider: AgentType): Promise<ProviderModelCatalogResult>;
}

function parseCookies(cookieHeader: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!cookieHeader) {
    return cookies;
  }

  for (const pair of cookieHeader.split(";")) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      continue;
    }
    cookies.set(key, value);
  }
  return cookies;
}

function contentTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function normalizeThreadSelector(threadId: string | undefined): { thread_id: string; target: string } {
  const normalized = threadId?.trim();
  if (!normalized) {
    return {
      thread_id: "active",
      target: "active"
    };
  }

  return {
    thread_id: normalized,
    target: normalized
  };
}

function parseInstancesContent(content: string): unknown[] {
  const normalized = content.trim();
  if (!normalized || normalized === "No active agent instances.") {
    return [];
  }

  const parsed = JSON.parse(normalized) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Hub returned a non-array instances payload");
  }
  return parsed;
}

function buildFallbackModelCatalogPayload(entry: Record<string, unknown>, threadId: string): Record<string, unknown> {
  const parsedProvider = AgentTypeSchema.safeParse(entry.agent_type);
  const currentModelId = typeof entry.model_id === "string" && entry.model_id.trim()
    ? entry.model_id.trim()
    : null;
  return {
    thread_id: threadId,
    provider: parsedProvider.success ? parsedProvider.data : "codex",
    current_model_id: currentModelId,
    models: currentModelId
      ? [
          {
            id: currentModelId,
            label: currentModelId
          }
        ]
      : []
  };
}

function normalizeRelativePath(inputPath: string): string {
  const normalized = path.posix.normalize(inputPath.trim().replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("Invalid relative file path");
  }
  return normalized;
}

function resolvePathWithinRoot(rootDir: string, relativePath: string): string {
  const normalizedRelative = normalizeRelativePath(relativePath);
  const rootResolved = path.resolve(rootDir);
  const resolved = path.resolve(rootResolved, normalizedRelative);
  if (!resolved.startsWith(`${rootResolved}${path.sep}`) && resolved !== rootResolved) {
    throw new Error("Resolved path escapes working directory");
  }
  return resolved;
}

async function listRepoEntries(rootDir: string, maxDepth: number): Promise<RepoEntry[]> {
  const result: RepoEntry[] = [];
  const rootResolved = path.resolve(rootDir);

  const walk = async (relativeDir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) {
      return;
    }
    const absoluteDir = relativeDir ? path.join(rootResolved, relativeDir) : rootResolved;
    const entries = await fs.promises.readdir(absoluteDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        result.push({ path: relativePath, kind: "dir" });
        await walk(relativePath, depth + 1);
        continue;
      }
      if (entry.isFile()) {
        result.push({ path: relativePath, kind: "file" });
      }
    }
  };

  await walk("", 1);
  return result;
}

const MAX_LOG_VIEW_BYTES = 2 * 1024 * 1024;

async function readLogFileForView(
  logDir: string,
  relativePath: string
): Promise<{ path: string; content: string; truncated: boolean }> {
  const absolutePath = resolvePathWithinRoot(logDir, relativePath);
  const stats = await fs.promises.stat(absolutePath);
  if (!stats.isFile()) {
    const err = new Error("Not a file") as NodeJS.ErrnoException;
    err.code = "EISDIR";
    throw err;
  }
  if (stats.size <= MAX_LOG_VIEW_BYTES) {
    const content = await fs.promises.readFile(absolutePath, "utf8");
    return { path: relativePath, content, truncated: false };
  }
  const handle = await fs.promises.open(absolutePath, "r");
  try {
    const toRead = Math.min(stats.size, MAX_LOG_VIEW_BYTES);
    const buffer = Buffer.alloc(toRead);
    await handle.read(buffer, 0, toRead, stats.size - toRead);
    let text = buffer.toString("utf8");
    const nl = text.indexOf("\n");
    if (nl >= 0 && nl < text.length - 1) {
      text = text.slice(nl + 1);
    }
    const prefix = `[... large file (${stats.size} bytes); showing last ${toRead} bytes ...]\n`;
    return { path: relativePath, content: prefix + text, truncated: true };
  } finally {
    await handle.close();
  }
}

async function clearLogFileOnDisk(logDir: string, relativePath: string): Promise<void> {
  const absolutePath = resolvePathWithinRoot(logDir, relativePath);
  const stats = await fs.promises.stat(absolutePath);
  if (!stats.isFile()) {
    const err = new Error("Not a file") as NodeJS.ErrnoException;
    err.code = "EISDIR";
    throw err;
  }
  await fs.promises.truncate(absolutePath, 0);
}

function readPackageVersion(): string {
  try {
    const packagePath = path.resolve(__dirname, "../../package.json");
    const raw = fs.readFileSync(packagePath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function inferSocketUptimeSeconds(socketPath: string): Promise<number> {
  try {
    const stats = await fs.promises.stat(socketPath);
    const startedAtMs = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.ctimeMs;
    return Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  } catch {
    return 0;
  }
}

export class WebInterfaceServer {
  private readonly enabled: boolean;
  private readonly port: number;
  private readonly listenHost: string;
  private readonly token: string;
  private readonly hubSocketPath: string;
  private readonly logDir: string;
  private readonly httpsEnabled: boolean;
  private readonly tlsCertPath: string;
  private readonly tlsKeyPath: string;
  private readonly staticDir: string;
  private readonly requestHub: (message: HubMessage) => Promise<HubResult>;
  private readonly requestHubRun: (message: HubMessage) => Promise<HubResult>;
  private readonly requestHubAsCaller: (
    message: HubMessage,
    auth: WireAuth,
    options?: { run?: boolean }
  ) => Promise<HubResult>;
  private readonly requestAdminHub: (message: HubMessage) => Promise<HubResult>;
  private readonly providerModelCatalog: ProviderModelCatalogLookup;
  private readonly hubSocketFactory: (socketPath: string) => net.Socket;
  private readonly logger: WebInterfaceLogger;
  private server: http.Server | https.Server | null = null;
  private loopbackSentinels: Array<http.Server | https.Server> = [];

  constructor(options: WebInterfaceServerOptions = {}) {
    this.enabled = options.enabled ?? config.WEB_GUI_ENABLED;
    this.port = options.port ?? config.WEB_GUI_PORT;
    this.listenHost = options.listenHost ?? "0.0.0.0";
    this.token = (options.token ?? config.WEB_GUI_TOKEN).trim();
    this.hubSocketPath = options.hubSocketPath ?? config.HUB_SOCKET_PATH;
    this.logDir = options.logDir ?? config.LOG_DIR;
    this.httpsEnabled = options.httpsEnabled ?? config.WEB_GUI_HTTPS;
    this.tlsCertPath = options.tlsCertPath ?? config.TLS_CERT_PATH;
    this.tlsKeyPath = options.tlsKeyPath ?? config.TLS_KEY_PATH;
    this.staticDir = options.staticDir ?? defaultStaticDir;
    // Test seam: if a routerOverride is supplied, default the four hub-sender
    // slots to in-process `router.route()` calls so tests can exercise the
    // real HTTP → router pipeline without spinning up a HubServer + IPC.
    // Explicit per-slot overrides still win.
    const router = options.routerOverride;
    this.requestHub = options.requestHub ?? (router ? (m) => router.route(m) : requestHubMessage);
    this.requestHubRun = options.requestHubRun ?? (router ? (m) => router.route(m) : requestHubRunMessage);
    this.requestHubAsCaller = options.requestHubAsCaller ?? (
      router
        ? (message, auth) => {
            // Inject the wire caller into message.caller so the router's
            // handlers see the authenticated identity even though we are
            // skipping the IPC/registry auth round-trip in this test seam.
            const authority = auth.caller_id === "meridian-admin" ? "admin" : "write";
            const enriched = {
              ...message,
              caller: { caller_id: auth.caller_id, caller_label: auth.caller_id, caller_authority: authority }
            } as HubMessage;
            return router.route(enriched);
          }
        : ((message, authParam, requestOptions) =>
            this.requestHubWithCallerIdentity(message, authParam, requestOptions))
    );
    this.requestAdminHub = options.requestAdminHub ?? (
      router
        ? (message) => {
            const enriched = {
              ...message,
              caller: { caller_id: "meridian-admin", caller_label: "Meridian Admin", caller_authority: "admin" as const }
            } as HubMessage;
            return router.route(enriched);
          }
        : this.buildAdminSender()
    );
    this.providerModelCatalog = options.providerModelCatalog ?? new SharedProviderModelCatalog();
    this.hubSocketFactory = options.hubSocketFactory ?? ((socketPath: string) => net.createConnection(socketPath));
    this.logger = options.logger ?? createLogger("web");

    if (this.enabled && !this.token) {
      throw new Error("WEB_GUI_TOKEN is required when Web Interface Server is enabled");
    }
  }

  async start(): Promise<boolean> {
    if (!this.enabled) {
      this.logger.info({ enabled: false }, "Web Interface Server disabled; skipping startup");
      return false;
    }
    if (this.server) {
      return true;
    }

    const requestListener: http.RequestListener = (request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        const isBadRequest = error instanceof z.ZodError || (error instanceof Error && error.message.startsWith("Invalid JSON body:"));
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error({ err: errorMessage }, "Web request failed");
        if (!response.headersSent) {
          response.writeHead(isBadRequest ? 400 : 500, { "content-type": "application/json; charset=utf-8" });
        }
        const clientMessage = isBadRequest
          ? "Invalid request payload"
          : this.friendlyErrorMessage(errorMessage);
        response.end(JSON.stringify({ error: clientMessage }));
      });
    };

    this.server = this.httpsEnabled ? await this.createHttpsServer(requestListener) : http.createServer(requestListener);

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, this.listenHost, () => resolve());
    });

    this.logger.info(
      {
        listen_host: this.listenHost,
        port: this.address()?.port ?? this.port,
        protocol: this.httpsEnabled ? "https" : "http",
        static_dir: this.staticDir
      },
      "Web Interface Server listening"
    );

    if (this.listenHost === "0.0.0.0" || this.listenHost === "::") {
      await this.reserveLoopbackSentinels(requestListener);
    }
    return true;
  }

  private async reserveLoopbackSentinels(requestListener: http.RequestListener): Promise<void> {
    for (const sentinelHost of ["127.0.0.1", "::1"]) {
      const sentinel = this.httpsEnabled
        ? await this.createHttpsServer(requestListener)
        : http.createServer(requestListener);
      try {
        await new Promise<void>((resolve, reject) => {
          sentinel.once("error", reject);
          sentinel.listen(this.port, sentinelHost, () => resolve());
        });
        this.loopbackSentinels.push(sentinel);
        this.logger.info({ host: sentinelHost, port: this.port }, "Web Interface Server reserved loopback");
      } catch (error) {
        this.logger.warn(
          { host: sentinelHost, port: this.port, err: error instanceof Error ? error.message : String(error) },
          "Failed to reserve loopback port (another process may be shadowing the live service)"
        );
        sentinel.close();
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    const sentinels = this.loopbackSentinels;
    this.loopbackSentinels = [];
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
            resolve();
            return;
          }
          reject(error);
        });
      }),
      ...sentinels.map((sentinel) =>
        new Promise<void>((resolve) => {
          sentinel.close(() => resolve());
        })
      )
    ]);
  }

  address(): net.AddressInfo | null {
    if (!this.server) {
      return null;
    }

    const address = this.server.address();
    if (!address || typeof address === "string") {
      return null;
    }
    return address;
  }

  private async createHttpsServer(listener: http.RequestListener): Promise<https.Server> {
    const [cert, key] = await Promise.all([
      fs.promises.readFile(this.tlsCertPath),
      fs.promises.readFile(this.tlsKeyPath)
    ]);

    return https.createServer({ cert, key }, listener);
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const requestUrl = this.getRequestUrl(request);
    if (!this.isAuthorized(request, requestUrl) && !this.isPublicStaticAsset(requestUrl.pathname)) {
      this.respondUnauthorized(response, requestUrl.pathname.startsWith("/api/"));
      return;
    }

    this.resolveSessionId(request, requestUrl, response);

    if (requestUrl.pathname === "/api/instances" && request.method === "GET") {
      await this.handleInstancesRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/health" && request.method === "GET") {
      await this.handleHealthRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/logs" && request.method === "GET") {
      await this.handleLogInventoryRequest(response);
      return;
    }

    if (requestUrl.pathname === "/api/log_file" && request.method === "GET") {
      await this.handleLogFileReadRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/log_file/clear" && request.method === "POST") {
      await this.handleLogFileClearRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/run" && request.method === "POST") {
      await this.handleRunRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/kill" && request.method === "POST") {
      await this.handleThreadActionRequest(request, response, "kill");
      return;
    }

    if (requestUrl.pathname === "/api/interrupt" && request.method === "POST") {
      await this.handleThreadActionRequest(request, response, "interrupt");
      return;
    }

    if (requestUrl.pathname === "/api/reboot" && request.method === "POST") {
      await this.handleThreadActionRequest(request, response, "reboot");
      return;
    }

    if (requestUrl.pathname === "/api/detach" && request.method === "POST") {
      await this.handleThreadActionRequest(request, response, "detach");
      return;
    }

    if (requestUrl.pathname === "/api/spawn_repos/browse" && request.method === "GET") {
      await this.handleSpawnReposBrowseRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/spawn_repos" && request.method === "GET") {
      await this.handleSpawnReposRequest(response);
      return;
    }

    if (requestUrl.pathname === "/api/spawn" && request.method === "POST") {
      await this.handleSpawnRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/files" && request.method === "GET") {
      await this.handleFilesRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/history" && request.method === "GET") {
      await this.handleHistoryRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/history_threads" && request.method === "GET") {
      await this.handleHistoryThreadsRequest(request, response);
      return;
    }

    if (requestUrl.pathname.startsWith("/api/progress/") && request.method === "GET") {
      await this.handleProgressRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/file" && request.method === "GET") {
      await this.handleFileReadRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/file" && request.method === "POST") {
      await this.handleFileWriteRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/terminal_input" && request.method === "POST") {
      await this.handleTerminalInputRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/push" && request.method === "POST") {
      await this.handlePushToggleRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/models" && request.method === "GET") {
      await this.handleModelsRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/models" && request.method === "POST") {
      await this.handleSwitchModelRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/capabilities" && request.method === "GET") {
      await this.handleCapabilitiesRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/capture_interval" && request.method === "GET") {
      await this.handleGetCaptureInterval(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/capture_interval" && request.method === "POST") {
      await this.handleSetCaptureInterval(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/autoapprove" && request.method === "GET") {
      await this.handleAutoApproveQueryRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/autoapprove" && request.method === "POST") {
      await this.handleAutoApproveSetRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/callers" && request.method === "GET") {
      await this.handleListCallersRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/callers" && request.method === "POST") {
      await this.handleRegisterCallerRequest(request, response);
      return;
    }

    if (requestUrl.pathname.startsWith("/api/callers/")) {
      const callerSuffix = requestUrl.pathname.slice("/api/callers/".length);
      if (request.method === "POST" && callerSuffix.endsWith("/rotate")) {
        const callerId = decodeURIComponent(callerSuffix.slice(0, -"/rotate".length));
        if (callerId && !callerId.includes("/")) {
          await this.handleRotateCallerKeyRequest(request, response, callerId);
          return;
        }
      }
      if (request.method === "PATCH" && callerSuffix.endsWith("/authority")) {
        const callerId = decodeURIComponent(callerSuffix.slice(0, -"/authority".length));
        if (callerId && !callerId.includes("/")) {
          await this.handleUpdateCallerAuthorityRequest(request, response, callerId);
          return;
        }
      }
      if (request.method === "DELETE" && callerSuffix && !callerSuffix.includes("/")) {
        const callerId = decodeURIComponent(callerSuffix);
        await this.handleUnregisterCallerRequest(request, response, callerId);
        return;
      }
    }

    if (requestUrl.pathname === "/api/credentials" && request.method === "GET") {
      await this.handleListCredentialsRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/credentials/api-key" && request.method === "POST") {
      await this.handleRegisterApiKeyRequest(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/credentials/oauth-login" && request.method === "POST") {
      await this.handleOAuthLoginStartRequest(request, response);
      return;
    }

    if (requestUrl.pathname.startsWith("/api/credentials/oauth-login/")) {
      const jobId = decodeURIComponent(requestUrl.pathname.slice("/api/credentials/oauth-login/".length));
      if (jobId && !jobId.includes("/")) {
        if (request.method === "GET") {
          await this.handleOAuthLoginPollRequest(request, response, jobId);
          return;
        }
        if (request.method === "DELETE") {
          await this.handleOAuthLoginCancelRequest(request, response, jobId);
          return;
        }
      }
    }

    if (requestUrl.pathname.startsWith("/api/credentials/")) {
      const credentialSuffix = requestUrl.pathname.slice("/api/credentials/".length);
      if (request.method === "POST" && credentialSuffix.endsWith("/default")) {
        const credentialId = decodeURIComponent(credentialSuffix.slice(0, -"/default".length));
        if (credentialId && !credentialId.includes("/")) {
          await this.handleSetDefaultCredentialRequest(request, response, credentialId);
          return;
        }
      }
      if (request.method === "PATCH" && credentialSuffix && !credentialSuffix.includes("/")) {
        const credentialId = decodeURIComponent(credentialSuffix);
        await this.handleUpdateCredentialRequest(request, response, credentialId);
        return;
      }
      if (request.method === "DELETE" && credentialSuffix && !credentialSuffix.includes("/")) {
        const credentialId = decodeURIComponent(credentialSuffix);
        await this.handleRevokeCredentialRequest(request, response, credentialId);
        return;
      }
    }

    await this.serveStaticAsset(requestUrl.pathname, response);
  }

  private async handleInstancesRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const result = HubResultSchema.parse(
      await this.requestHub(
        this.buildHubMessage({
          sessionId,
          intent: "list",
          thread_id: "global",
          target: "all",
          content: ""
        })
      )
    );

    this.respondJson(response, 200, parseInstancesContent(result.content));
  }

  private async handleHealthRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const result = HubResultSchema.parse(
      await this.requestHub(
        this.buildHubMessage({
          sessionId,
          intent: "list",
          thread_id: "global",
          target: "all",
          content: ""
        })
      )
    );

    if (result.status !== "success") {
      this.respondJson(response, 503, { ok: false, error: this.friendlyErrorMessage(result.content) });
      return;
    }

    const instances = parseInstancesContent(result.content);
    const uptime = await inferSocketUptimeSeconds(this.hubSocketPath);
    this.respondJson(response, 200, {
      ok: true,
      version: packageVersion,
      uptime,
      agents_count: instances.length
    });
  }

  private async handleLogInventoryRequest(response: http.ServerResponse): Promise<void> {
    const inventory = await collectLogInventory(this.logDir);
    this.respondJson(response, 200, inventory);
  }

  private async handleLogFileReadRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const requestUrl = this.getRequestUrl(request);
    let query: z.infer<typeof logFileReadQuerySchema>;
    try {
      query = logFileReadQuerySchema.parse({
        path: requestUrl.searchParams.get("path")
      });
    } catch {
      this.respondJson(response, 400, { error: "Invalid path parameter" });
      return;
    }
    try {
      const result = await readLogFileForView(this.logDir, query.path);
      this.respondJson(response, 200, result);
    } catch (err) {
      const e = err as NodeJS.ErrnoException & Error;
      if (e.message === "Invalid relative file path" || e.message === "Resolved path escapes working directory") {
        this.respondJson(response, 400, { error: e.message });
        return;
      }
      if (e.code === "ENOENT") {
        this.respondJson(response, 404, { error: "Log file not found" });
        return;
      }
      if (e.code === "EISDIR") {
        this.respondJson(response, 404, { error: "Not a file" });
        return;
      }
      this.logger.warn({ err: e }, "log file read failed");
      this.respondJson(response, 500, { error: "Failed to read log file" });
    }
  }

  private async handleLogFileClearRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    let body: z.infer<typeof logFileClearBodySchema>;
    try {
      body = logFileClearBodySchema.parse(await this.readJsonBody(request));
    } catch {
      this.respondJson(response, 400, { error: "Invalid request body (expected { path: string } for a .log file)" });
      return;
    }
    try {
      await clearLogFileOnDisk(this.logDir, body.path);
      this.logger.info({ path: body.path }, "log file cleared via web UI");
      this.respondJson(response, 200, { ok: true, path: body.path });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & Error;
      if (e.message === "Invalid relative file path" || e.message === "Resolved path escapes working directory") {
        this.respondJson(response, 400, { error: e.message });
        return;
      }
      if (e.code === "ENOENT") {
        this.respondJson(response, 404, { error: "Log file not found" });
        return;
      }
      if (e.code === "EISDIR") {
        this.respondJson(response, 404, { error: "Not a file" });
        return;
      }
      this.logger.warn({ err: e }, "log file clear failed");
      this.respondJson(response, 500, { error: "Failed to clear log file" });
    }
  }

  private async handleRunRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const body = runRequestBodySchema.parse(await this.readJsonBody(request));
    const threadSelector = normalizeThreadSelector(body.thread_id);
    const stagedAttachments = await stageInlineAttachments(body.attachments);

    try {
      const result = HubResultSchema.parse(
        await this.requestHubForRequest(
          request,
          this.buildHubMessage({
            sessionId,
            intent: "run",
            thread_id: threadSelector.thread_id,
            target: threadSelector.target,
            content: body.content,
            attachments: stagedAttachments.attachments
          }),
          { run: true }
        )
      );

      this.respondJson(response, 200, {
        ...result,
        attachment_results: result.attachment_results ?? []
      });
    } finally {
      await cleanupStagedAttachments(stagedAttachments.cleanupPaths);
    }
  }

  private async handleThreadActionRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    intent: "kill" | "interrupt" | "reboot" | "detach"
  ): Promise<void> {
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const body = threadActionBodySchema.parse(await this.readJsonBody(request));
    const threadSelector = normalizeThreadSelector(body.thread_id);
    const result = HubResultSchema.parse(
      await this.requestHubForRequest(
        request,
        this.buildHubMessage({
          sessionId,
          intent,
          thread_id: threadSelector.thread_id,
          target: threadSelector.target,
          content: ""
        })
      )
    );

    this.respondJson(response, 200, result);
  }

  private async handleSpawnReposRequest(response: http.ServerResponse): Promise<void> {
    const root = path.resolve(config.AGENT_WORKDIR);
    let repos: Array<{ name: string }> = [];
    try {
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      repos = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name }))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 64);
    } catch {
      repos = [];
    }
    this.respondJson(response, 200, { root, repos });
  }

  private async handleSpawnRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const body = spawnRequestBodySchema.parse(await this.readJsonBody(request));
    const modelReference = parseModelReference(body.model_id, body.effort);
    const isAdsPublicProfile = body.integration_profile === "ads_public";
    const target = body.provider ?? body.type;
    if (isAdsPublicProfile && target !== "codex") {
      this.respondJson(response, 400, { error: "ads_public integration_profile requires codex provider" });
      return;
    }
    const mode = isAdsPublicProfile ? "stateless_call" : body.mode;
    const autoApprove = isAdsPublicProfile ? false : body.auto_approve;
    const sandboxMode = isAdsPublicProfile ? "read-only" : body.sandbox_mode;
    const hostHeader = request.headers.host;
    let spawnDir: string | undefined;
    if (!isAdsPublicProfile) {
      try {
        spawnDir = await this.resolveSpawnDirectoryForSpawnRequest(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.respondJson(response, 400, { error: message });
        return;
      }
    }
    const result = HubResultSchema.parse(
      await this.requestHubForRequest(
        request,
        this.buildHubMessage({
          sessionId,
          intent: "spawn",
          thread_id: "pending",
          target,
          content: "",
          mode,
          autoApprove,
          guiHostPortOverride: typeof hostHeader === "string" ? hostHeader.trim() : undefined,
          spawnDir,
          modelId: modelReference.modelId,
          effort: modelReference.reasoningEffort,
          integrationProfile: body.integration_profile,
          sandboxMode,
          credentialId: body.credential_id,
          caller: this.extractInboundCaller(request)
        })
      )
    );

    this.respondJson(response, 200, result);
  }

  /**
   * Resolves optional `repo` (relative to AGENT_WORKDIR) or `spawn_dir` (absolute) to a directory
   * for the new agent. Relative `repo` values resolve from AGENT_WORKDIR; absolute `repo` and
   * `spawn_dir` values may point anywhere on the host. Hub receives `spawn_dir` in the message payload.
   */
  private async resolveSpawnDirectoryForSpawnRequest(
    body: z.infer<typeof spawnRequestBodySchema>
  ): Promise<string | undefined> {
    const root = path.resolve(config.AGENT_WORKDIR);
    const rawSpawnDir = body.spawn_dir?.trim();
    const rawRepo = body.repo?.trim();
    if (rawSpawnDir && rawRepo) {
      throw new Error("Specify only one of spawn_dir or repo");
    }
    if (rawSpawnDir) {
      return this.assertExistingDirectory(path.resolve(rawSpawnDir));
    }
    if (rawRepo) {
      if (path.isAbsolute(rawRepo)) {
        return this.assertExistingDirectory(path.resolve(rawRepo));
      }
      const normalized = normalizeRelativePath(rawRepo);
      const parts = normalized.split("/").filter(Boolean);
      const resolved = path.resolve(root, ...parts);
      return this.assertDirectoryUnderAgentRoot(resolved, root);
    }
    return undefined;
  }

  private async handleSpawnReposBrowseRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const requestUrl = this.getRequestUrl(request);
    const rawParam = requestUrl.searchParams.get("relative") ?? "";
    const root = path.resolve(config.AGENT_WORKDIR);
    const trimmedParam = rawParam.trim();
    let browsePath = "";
    let resolvedDir = root;
    try {
      if (trimmedParam) {
        if (path.isAbsolute(trimmedParam)) {
          browsePath = path.resolve(trimmedParam);
          resolvedDir = browsePath;
        } else {
          browsePath = normalizeRelativePath(trimmedParam);
          resolvedDir = path.resolve(root, ...browsePath.split("/").filter(Boolean));
        }
      }
    } catch {
      this.respondJson(response, 400, { error: "Invalid browse path" });
      return;
    }

    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(resolvedDir);
    } catch {
      this.respondJson(response, 404, { error: "Directory not found" });
      return;
    }
    if (!stats.isDirectory()) {
      this.respondJson(response, 400, { error: "Not a directory" });
      return;
    }

    const entries: Array<{ name: string; kind: "directory" }> = [];
    try {
      const dirents = await fs.promises.readdir(resolvedDir, { withFileTypes: true });
      for (const entry of dirents) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (entry.name.startsWith(".")) {
          continue;
        }
        entries.push({ name: entry.name, kind: "directory" });
      }
    } catch {
      // keep empty entries on read errors
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    const limited = entries.slice(0, 64);

    let parent_relative: string | null = null;
    if (browsePath) {
      if (path.isAbsolute(browsePath)) {
        const parent = path.dirname(browsePath);
        parent_relative = parent === browsePath ? null : parent;
      } else {
        const parts = browsePath.split("/").filter(Boolean);
        parts.pop();
        parent_relative = parts.length ? parts.join("/") : "";
      }
    } else {
      const parent = path.dirname(root);
      parent_relative = parent === root ? null : parent;
    }

    this.respondJson(response, 200, {
      root,
      relative: browsePath,
      parent_relative,
      entries: limited
    });
  }

  private async assertDirectoryUnderAgentRoot(resolvedPath: string, agentRoot: string): Promise<string> {
    if (resolvedPath !== agentRoot && !resolvedPath.startsWith(`${agentRoot}${path.sep}`)) {
      throw new Error("Working directory must be under AGENT_WORKDIR");
    }
    return this.assertExistingDirectory(resolvedPath);
  }

  private async assertExistingDirectory(resolvedPath: string): Promise<string> {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(resolvedPath);
    } catch {
      throw new Error(`Working directory does not exist: ${resolvedPath}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Working directory is not a directory: ${resolvedPath}`);
    }
    return resolvedPath;
  }

  private async handleFilesRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const requestUrl = this.getRequestUrl(request);
    const sessionId = this.resolveSessionId(request, requestUrl, response);
    const query = filesQuerySchema.parse({
      thread_id: requestUrl.searchParams.get("thread_id"),
      depth: requestUrl.searchParams.get("depth") ?? undefined
    });
    const workingDir = await this.resolveWorkingDirectory(sessionId, query.thread_id);
    const entries = await listRepoEntries(workingDir, query.depth);
    this.respondJson(response, 200, entries);
  }

  private async handleFileReadRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const requestUrl = this.getRequestUrl(request);
    const sessionId = this.resolveSessionId(request, requestUrl, response);
    const query = fileReadQuerySchema.parse({
      thread_id: requestUrl.searchParams.get("thread_id"),
      path: requestUrl.searchParams.get("path")
    });
    const workingDir = await this.resolveWorkingDirectory(sessionId, query.thread_id);
    const absolutePath = resolvePathWithinRoot(workingDir, query.path);
    const content = await fs.promises.readFile(absolutePath, "utf8");
    this.respondJson(response, 200, { path: query.path, content });
  }

  private async handleHistoryRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const requestUrl = this.getRequestUrl(request);
    const sessionId = this.resolveSessionId(request, requestUrl, response);
    const query = historyQuerySchema.parse({
      thread_id: requestUrl.searchParams.get("thread_id"),
      limit: requestUrl.searchParams.get("limit") ?? undefined,
      max_content_chars: requestUrl.searchParams.get("max_content_chars") ?? undefined,
      max_detail_chars: requestUrl.searchParams.get("max_detail_chars") ?? undefined,
      max_raw_chars: requestUrl.searchParams.get("max_raw_chars") ?? undefined
    });
    const result = HubResultSchema.parse(
      await this.requestHub(
        this.buildHubMessage({
          sessionId,
          intent: "history",
          thread_id: query.thread_id,
          target: query.thread_id,
          content: "",
          historyLimit: query.limit,
          historyMaxContentChars: query.max_content_chars,
          historyMaxDetailChars: query.max_detail_chars,
          historyMaxRawChars: query.max_raw_chars
        })
      )
    );
    this.respondJson(
      response,
      200,
      shapeHistoryPayload(JSON.parse(result.content) as unknown, {
        limit: query.limit,
        maxContentChars: query.max_content_chars,
        maxDetailChars: query.max_detail_chars,
        maxRawChars: query.max_raw_chars
      })
    );
  }

  private async handleHistoryThreadsRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const requestUrl = this.getRequestUrl(request);
    const sessionId = this.resolveSessionId(request, requestUrl, response);
    const result = HubResultSchema.parse(
      await this.requestHub(
        this.buildHubMessage({
          sessionId,
          intent: "history",
          thread_id: "global",
          target: "all",
          content: ""
        })
      )
    );
    this.respondJson(response, 200, JSON.parse(result.content) as unknown);
  }

  private async handleProgressRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const requestUrl = this.getRequestUrl(request);
    const sessionId = this.resolveSessionId(request, requestUrl, response);
    const query = threadQuerySchema.parse({
      thread_id: decodeURIComponent(requestUrl.pathname.slice("/api/progress/".length))
    });
    const result = HubResultSchema.parse(
      await this.requestHub(
        this.buildHubMessage({
          sessionId,
          intent: "monitor_manual_update",
          thread_id: query.thread_id,
          target: query.thread_id,
          content: `/mupdate thread=${query.thread_id}`
        })
      )
    );

    if (result.status === "error") {
      const statusCode = /no registered agent instance found/i.test(result.content) ? 404 : 502;
      this.respondJson(response, statusCode, { error: this.friendlyErrorMessage(result.content) });
      return;
    }

    this.respondJson(response, 200, coerceProgressSnapshot(result));
  }

  private async handleFileWriteRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const body = fileWriteBodySchema.parse(await this.readJsonBody(request));
    const workingDir = await this.resolveWorkingDirectory(sessionId, body.thread_id);
    const absolutePath = resolvePathWithinRoot(workingDir, body.path);
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.promises.writeFile(absolutePath, body.content, "utf8");
    this.respondJson(response, 200, { ok: true, path: body.path });
  }

  private async handleTerminalInputRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const body = terminalInputBodySchema.parse(await this.readJsonBody(request));
    const threadSelector = normalizeThreadSelector(body.thread_id);
    const result = HubResultSchema.parse(
      await this.requestHub(
        this.buildHubMessage({
          sessionId,
          intent: "terminal_input",
          thread_id: threadSelector.thread_id,
          target: threadSelector.target,
          content: body.content
        })
      )
    );
    this.respondJson(response, 200, result);
  }

  private async handleModelsRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const requestUrl = this.getRequestUrl(request);
    const sessionId = this.resolveSessionId(request, requestUrl, response);
    const rawProvider = requestUrl.searchParams.get("provider");
    const rawThreadId = requestUrl.searchParams.get("thread_id");

    if (rawProvider && rawThreadId) {
      this.respondJson(response, 400, { error: "Specify either thread_id or provider, not both" });
      return;
    }

    if (rawProvider) {
      const provider = AgentTypeSchema.parse(rawProvider);
      const catalog = await this.providerModelCatalog.listModels(provider);
      this.respondJson(response, 200, {
        provider: catalog.provider,
        current_model_id: null,
        models: catalog.models
      });
      return;
    }

    const query = threadQuerySchema.parse({
      thread_id: rawThreadId
    });
    try {
      const result = HubResultSchema.parse(
        await this.requestHub(
          this.buildHubMessage({
            sessionId,
            intent: "list_models",
            thread_id: query.thread_id,
            target: query.thread_id,
            content: ""
          })
        )
      );
      if (result.status !== "success") {
        throw new Error(result.content || "Failed to load models");
      }
      this.respondJson(response, 200, JSON.parse(result.content) as unknown);
    } catch (error) {
      const fallbackCatalog = await this.resolveFallbackModelCatalog(sessionId, query.thread_id);
      if (fallbackCatalog) {
        this.respondJson(response, 200, fallbackCatalog);
        return;
      }
      throw error;
    }
  }

  private async handleSwitchModelRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const body = switchModelBodySchema.parse(await this.readJsonBody(request));
    const modelReference = parseModelReference(body.model_id, body.effort);
    if (!modelReference.modelId) {
      this.respondJson(response, 400, { error: "switch_model requires a provider model id" });
      return;
    }
    const result = HubResultSchema.parse(
      await this.requestHub(
        this.buildHubMessage({
          sessionId,
          intent: "switch_model",
          thread_id: body.thread_id,
          target: body.thread_id,
          content: modelReference.modelId,
          modelId: modelReference.modelId,
          effort: modelReference.reasoningEffort
        })
      )
    );
    this.respondJson(response, 200, result);
  }

  private async handleCapabilitiesRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const requestUrl = this.getRequestUrl(request);
    this.resolveSessionId(request, requestUrl, response);
    const rawType = requestUrl.searchParams.get("type");

    if (rawType) {
      const agentType = AgentTypeSchema.parse(rawType);
      try {
        this.respondJson(response, 200, ProviderCapabilitySchema.parse(getProviderCapabilities(agentType)));
      } catch (error) {
        if (error instanceof Error && error.message.includes("No provider capabilities configured")) {
          this.respondJson(response, 404, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }

    this.respondJson(response, 200, ProviderCapabilityListSchema.parse(listProviderCapabilities()));
  }

  private async handlePushToggleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const body = pushToggleBodySchema.parse(await this.readJsonBody(request));
    const threadSelector = normalizeThreadSelector(body.thread_id);
    const result = HubResultSchema.parse(
      await this.requestHub(
        HubMessageSchema.parse({
          trace_id: randomUUID(),
          thread_id: threadSelector.thread_id,
          actor_id: `web:${sessionId}`,
          intent: "push",
          target: threadSelector.target,
          payload: {
            content: "",
            attachments: [],
            reply_to: null,
            push_enabled: body.enabled ?? null
          },
          mode: "bridge",
          suppress_reply: true,
          reply_channel: {
            channel: "web",
            chat_id: `web:${sessionId}`
          }
        })
      )
    );
    this.respondJson(response, 200, result);
  }

  private async handleGetCaptureInterval(_request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const result = HubResultSchema.parse(
      await this.requestHub(
        HubMessageSchema.parse({
          trace_id: randomUUID(),
          thread_id: "global",
          actor_id: "web:system",
          intent: "capture_interval",
          target: "global",
          payload: { content: "", attachments: [] },
          mode: "bridge",
          suppress_reply: true,
          reply_channel: { channel: "web", chat_id: "web:system" }
        })
      )
    );
    const intervalMs = Number.parseInt(result.content, 10);
    this.respondJson(response, 200, { interval_ms: Number.isFinite(intervalMs) ? intervalMs : 7000 });
  }

  private async handleSetCaptureInterval(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const body = captureIntervalBodySchema.parse(await this.readJsonBody(request));
    const result = HubResultSchema.parse(
      await this.requestHub(
        HubMessageSchema.parse({
          trace_id: randomUUID(),
          thread_id: "global",
          actor_id: "web:system",
          intent: "capture_interval",
          target: "global",
          payload: { content: String(body.interval_ms), attachments: [] },
          mode: "bridge",
          suppress_reply: true,
          reply_channel: { channel: "web", chat_id: "web:system" }
        })
      )
    );
    const intervalMs = Number.parseInt(result.content, 10);
    this.respondJson(response, 200, { interval_ms: Number.isFinite(intervalMs) ? intervalMs : body.interval_ms });
  }

  private async handleAutoApproveQueryRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const requestUrl = this.getRequestUrl(request);
    const sessionId = this.resolveSessionId(request, requestUrl, response);
    const query = autoApproveQuerySchema.parse({
      thread_id: requestUrl.searchParams.get("thread_id")
    });
    const result = HubResultSchema.parse(
      await this.requestHub(
        this.buildHubMessage({
          sessionId,
          intent: "list",
          thread_id: "global",
          target: "all",
          content: ""
        })
      )
    );
    const instances = parseInstancesContent(result.content) as Array<Record<string, unknown>>;
    const matched = instances.find((entry) => String(entry.thread_id ?? "") === query.thread_id);
    if (!matched) {
      this.respondJson(response, 404, {
        error: `No active agent instance found for thread=${query.thread_id}`
      });
      return;
    }
    this.respondJson(response, 200, {
      thread_id: query.thread_id,
      auto_approve: matched.auto_approve === true
    });
  }

  private async handleAutoApproveSetRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const body = autoApproveSetBodySchema.parse(await this.readJsonBody(request));
    const result = HubResultSchema.parse(
      await this.requestHub(
        this.buildHubMessage({
          sessionId,
          intent: "set_auto_approve",
          thread_id: body.thread_id,
          target: body.thread_id,
          content: body.enabled ? "true" : "false"
        })
      )
    );
    if (result.status !== "success") {
      const statusCode = /no registered agent instance found|no active instance/i.test(result.content) ? 404 : 502;
      this.respondJson(response, statusCode, { error: this.friendlyErrorMessage(result.content) });
      return;
    }
    this.respondJson(response, 200, {
      thread_id: body.thread_id,
      auto_approve: body.enabled
    });
  }

  private async resolveWorkingDirectory(sessionId: string, threadId: string): Promise<string> {
    const result = HubResultSchema.parse(
      await this.requestHub(
        this.buildHubMessage({
          sessionId,
          intent: "list",
          thread_id: "global",
          target: "all",
          content: ""
        })
      )
    );
    const instances = parseInstancesContent(result.content) as Array<Record<string, unknown>>;
    const matched = instances.find((instance) => String(instance.thread_id ?? "") === threadId);
    if (!matched) {
      throw new Error(`No active instance found for thread_id=${threadId}`);
    }
    const workingDir = matched.working_dir;
    if (typeof workingDir !== "string" || !workingDir.trim()) {
      throw new Error(`Instance ${threadId} does not expose a working directory`);
    }
    return path.resolve(workingDir.trim());
  }

  private async serveStaticAsset(pathname: string, response: http.ServerResponse): Promise<void> {
    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const rootPath = path.resolve(this.staticDir);
    const filePath = path.resolve(rootPath, relativePath);
    if (!filePath.startsWith(`${rootPath}${path.sep}`) && filePath !== rootPath) {
      this.respondJson(response, 403, { error: "Forbidden" });
      return;
    }

    try {
      const stats = await fs.promises.stat(filePath);
      const finalPath = stats.isDirectory() ? path.join(filePath, "index.html") : filePath;
      const content = await fs.promises.readFile(finalPath);
      const ct = contentTypeForPath(finalPath);
      const headers: Record<string, string> = { "content-type": ct };
      if (ct.startsWith("text/html")) {
        headers["cache-control"] = "no-store";
      }
      response.writeHead(200, headers);
      response.end(content);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        this.respondJson(response, 404, { error: "Not found" });
        return;
      }
      throw error;
    }
  }

  private async resolveFallbackModelCatalog(
    sessionId: string,
    threadId: string
  ): Promise<Record<string, unknown> | null> {
    const liveResult = HubResultSchema.parse(
      await this.requestHub(
        this.buildHubMessage({
          sessionId,
          intent: "list",
          thread_id: "global",
          target: "all",
          content: ""
        })
      )
    );
    const liveInstances = parseInstancesContent(liveResult.content) as Array<Record<string, unknown>>;
    const liveMatch = liveInstances.find((entry) => String(entry.thread_id ?? "") === threadId);
    if (liveMatch) {
      return buildFallbackModelCatalogPayload(liveMatch, threadId);
    }

    const historyResult = HubResultSchema.parse(
      await this.requestHub(
        this.buildHubMessage({
          sessionId,
          intent: "history",
          thread_id: "global",
          target: "all",
          content: ""
        })
      )
    );
    const historyEntries = JSON.parse(historyResult.content) as Array<Record<string, unknown>>;
    const historyMatch = historyEntries.find((entry) => String(entry.thread_id ?? "") === threadId);
    return historyMatch ? buildFallbackModelCatalogPayload(historyMatch, threadId) : null;
  }

  private buildHubMessage(params: {
    sessionId: string;
    intent: Intent;
    thread_id: string;
    target: string;
    content: string;
    attachments?: FileAttachment[];
    mode?: "bridge" | "stateless_call";
    autoApprove?: boolean;
    guiHostPortOverride?: string;
    /** Passed through to Hub `payload.spawn_dir` (agent working directory). */
    spawnDir?: string;
    modelId?: string;
    effort?: ReasoningEffort;
    integrationProfile?: IntegrationProfile;
    sandboxMode?: SandboxMode;
    credentialId?: string;
    historyLimit?: number;
    historyMaxContentChars?: number;
    historyMaxDetailChars?: number;
    historyMaxRawChars?: number;
    caller?: CallerIdentity;
  }): HubMessage {
    return HubMessageSchema.parse({
      trace_id: randomUUID(),
      thread_id: params.thread_id,
      actor_id: `web:${params.sessionId}`,
      intent: params.intent,
      target: params.target,
      payload: {
        content: params.content,
        attachments: params.attachments ?? [],
        reply_to: null,
        ...(params.autoApprove !== undefined && { auto_approve: params.autoApprove }),
        ...(params.guiHostPortOverride && { gui_host_port_override: params.guiHostPortOverride }),
        ...(params.spawnDir && { spawn_dir: params.spawnDir }),
        ...(params.modelId && { model_id: params.modelId }),
        ...(params.effort && { effort: params.effort }),
        ...(params.integrationProfile && { integration_profile: params.integrationProfile }),
        ...(params.sandboxMode && { sandbox_mode: params.sandboxMode }),
        ...(params.credentialId && { credential_id: params.credentialId }),
        ...(params.historyLimit !== undefined && { history_limit: params.historyLimit }),
        ...(params.historyMaxContentChars !== undefined && { history_max_content_chars: params.historyMaxContentChars }),
        ...(params.historyMaxDetailChars !== undefined && { history_max_detail_chars: params.historyMaxDetailChars }),
        ...(params.historyMaxRawChars !== undefined && { history_max_raw_chars: params.historyMaxRawChars })
      },
      mode: params.mode ?? "bridge",
      suppress_reply: true,
      reply_channel: {
        channel: "web",
        chat_id: `web:${params.sessionId}`
      },
      ...(params.caller !== undefined ? { caller: params.caller } : {})
    });
  }

  private buildAdminSender(): (message: HubMessage) => Promise<HubResult> {
    const socketPath = this.hubSocketPath;
    let sender: IpcSender | null = null;
    return async (message: HubMessage): Promise<HubResult> => {
      if (!sender) {
        const key = deriveBuiltinCallerKey("meridian-admin");
        sender = new IpcSender({ socketPath });
        sender.setCallerIdentity({ caller_id: "meridian-admin", caller_key: key, caller_label: "Meridian Admin" });
      }
      return sender.request(message);
    };
  }

  private extractInboundCaller(request: http.IncomingMessage): CallerIdentity | undefined {
    const envelope = this.extractInboundCallerEnvelope(request);
    if (!envelope) return undefined;
    return { caller_id: envelope.caller_id };
  }

  private extractInboundCallerEnvelope(request: http.IncomingMessage): WireAuth | null {
    return callerEnvelopeFromHttpHeaders(request.headers as Record<string, string | string[] | undefined>);
  }

  private async requestHubForRequest(
    request: http.IncomingMessage,
    message: HubMessage,
    options: { run?: boolean } = {}
  ): Promise<HubResult> {
    const auth = this.extractInboundCallerEnvelope(request);
    if (auth) {
      return this.requestHubAsCaller(message, auth, options);
    }
    return options.run ? this.requestHubRun(message) : this.requestHub(message);
  }

  private async requestHubWithCallerIdentity(
    message: HubMessage,
    auth: WireAuth,
    options: { run?: boolean } = {}
  ): Promise<HubResult> {
    const sender = new IpcSender({ socketPath: this.hubSocketPath });
    sender.setCallerIdentity({
      caller_id: auth.caller_id,
      caller_key: auth.caller_key,
      // The hub validates auth and replaces message.caller from CallerRegistry.
      caller_label: auth.caller_id
    });
    return options.run ? sender.requestRun(message) : sender.request(message);
  }

  private async handleListCallersRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const result = HubResultSchema.parse(
      await this.requestAdminHub(
        this.buildHubMessage({
          sessionId,
          intent: "list_callers",
          thread_id: "global",
          target: "global",
          content: "",
          caller: ADMIN_CALLER_IDENTITY
        })
      )
    );
    if (result.status !== "success") {
      this.respondJson(response, 502, { error: this.friendlyErrorMessage(result.content) });
      return;
    }
    const parsed = JSON.parse(result.content) as { callers?: Array<Record<string, unknown>>; bootstrap_key_set?: unknown };
    if (parsed && Array.isArray(parsed.callers)) {
      parsed.callers = parsed.callers.map((caller) => {
        const sanitized = { ...caller };
        delete sanitized.key_hash;
        return sanitized;
      });
    }
    this.respondJson(response, 200, parsed);
  }

  private async handleRegisterCallerRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    let body: z.infer<typeof registerCallerBodySchema>;
    try {
      body = registerCallerBodySchema.parse(await this.readJsonBody(request));
    } catch {
      this.respondJson(response, 400, { error: "Invalid request body: caller_id must match /^[a-z][a-z0-9_-]*$/, caller_label must be 1-64 chars, and caller_authority must be read, write, stateless_call, or admin" });
      return;
    }
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const result = HubResultSchema.parse(
      await this.requestAdminHub(
        this.buildHubMessage({
          sessionId,
          intent: "register_caller",
          thread_id: "global",
          target: "global",
          content: JSON.stringify({
            caller_id: body.caller_id,
            caller_label: body.caller_label,
            caller_kind: "external",
            ...(body.caller_authority && { caller_authority: body.caller_authority })
          }),
          caller: ADMIN_CALLER_IDENTITY
        })
      )
    );
    if (result.status !== "success") {
      const isConflict = result.content.includes("caller_already_exists");
      this.respondJson(response, isConflict ? 409 : 400, { error: result.content });
      return;
    }
    this.respondJson(response, 200, JSON.parse(result.content) as unknown);
  }

  private async handleRotateCallerKeyRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    callerId: string
  ): Promise<void> {
    if (BUILTIN_CALLER_ID_SET.has(callerId)) {
      this.respondJson(response, 400, { error: "Built-in callers are read-only; key rotation is not allowed" });
      return;
    }
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const result = HubResultSchema.parse(
      await this.requestAdminHub(
        this.buildHubMessage({
          sessionId,
          intent: "rotate_caller_key",
          thread_id: "global",
          target: "global",
          content: JSON.stringify({ caller_id: callerId }),
          caller: ADMIN_CALLER_IDENTITY
        })
      )
    );
    if (result.status !== "success") {
      const isNotFound = result.content.includes("caller_unknown");
      this.respondJson(response, isNotFound ? 404 : 400, { error: result.content });
      return;
    }
    this.respondJson(response, 200, JSON.parse(result.content) as unknown);
  }

  private async handleUpdateCallerAuthorityRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    callerId: string
  ): Promise<void> {
    if (BUILTIN_CALLER_ID_SET.has(callerId)) {
      this.respondJson(response, 400, { error: "Built-in callers are read-only; authority changes are not allowed" });
      return;
    }
    let body: z.infer<typeof callerAuthorityBodySchema>;
    try {
      body = callerAuthorityBodySchema.parse(await this.readJsonBody(request));
    } catch {
      this.respondJson(response, 400, { error: "Invalid request body: caller_authority must be read, write, stateless_call, or admin" });
      return;
    }
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const result = HubResultSchema.parse(
      await this.requestAdminHub(
        this.buildHubMessage({
          sessionId,
          intent: "update_caller_authority",
          thread_id: "global",
          target: "global",
          content: JSON.stringify({ caller_id: callerId, caller_authority: body.caller_authority }),
          caller: ADMIN_CALLER_IDENTITY
        })
      )
    );
    if (result.status !== "success") {
      const isNotFound = result.content.includes("caller_unknown");
      this.respondJson(response, isNotFound ? 404 : 400, { error: result.content });
      return;
    }
    this.respondJson(response, 200, JSON.parse(result.content) as unknown);
  }

  private async handleUnregisterCallerRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    callerId: string
  ): Promise<void> {
    if (BUILTIN_CALLER_ID_SET.has(callerId)) {
      this.respondJson(response, 400, { error: "Built-in callers are read-only; revoke is not allowed" });
      return;
    }
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const result = HubResultSchema.parse(
      await this.requestAdminHub(
        this.buildHubMessage({
          sessionId,
          intent: "unregister_caller",
          thread_id: "global",
          target: "global",
          content: JSON.stringify({ caller_id: callerId }),
          caller: ADMIN_CALLER_IDENTITY
        })
      )
    );
    if (result.status !== "success") {
      const isNotFound = result.content.includes("caller_unknown");
      this.respondJson(response, isNotFound ? 404 : 400, { error: result.content });
      return;
    }
    this.respondJson(response, 200, JSON.parse(result.content) as unknown);
  }

  /**
   * Translates a credential-intent HubResult error_code into an HTTP status code.
   * Owner-or-admin auth and existence checks happen inside the intent handlers
   * (router.ts), so we only translate; we don't re-enforce.
   */
  private credentialErrorStatus(errorCode: string | undefined): number {
    switch (errorCode) {
      case "credential_not_found":
        return 404;
      case "credential_revoked":
        return 410;
      case "credential_forbidden":
        return 403;
      case "credential_store_unavailable":
      case "oauth_subsystem_unavailable":
        return 503;
      case "oauth_login_cap_exceeded":
        return 429;
      case "job_not_found":
        return 404;
      case "invalid_payload":
      case "caller_required":
        return 400;
      default:
        return 500;
    }
  }

  private parseCredentialErrorBody(raw: string): { error_code?: string; error_message?: string; [key: string]: unknown } {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        return parsed as { error_code?: string; error_message?: string };
      }
    } catch {
      // fall through
    }
    return { error_message: raw };
  }

  private async handleListCredentialsRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const result = HubResultSchema.parse(
      await this.requestHubForRequest(
        request,
        this.buildHubMessage({
          sessionId,
          intent: "list_credentials",
          thread_id: "global",
          target: "global",
          content: "",
          caller: this.extractInboundCaller(request)
        })
      )
    );
    if (result.status !== "success") {
      const body = this.parseCredentialErrorBody(result.content);
      this.respondJson(response, this.credentialErrorStatus(body.error_code), body);
      return;
    }
    this.respondJson(response, 200, JSON.parse(result.content) as unknown);
  }

  private async handleRevokeCredentialRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    credentialId: string
  ): Promise<void> {
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const result = HubResultSchema.parse(
      await this.requestHubForRequest(
        request,
        this.buildHubMessage({
          sessionId,
          intent: "revoke_credential",
          thread_id: "global",
          target: "global",
          content: JSON.stringify({ credential_id: credentialId }),
          caller: this.extractInboundCaller(request)
        })
      )
    );
    if (result.status !== "success") {
      const body = this.parseCredentialErrorBody(result.content);
      this.respondJson(response, this.credentialErrorStatus(body.error_code), body);
      return;
    }
    this.respondJson(response, 200, JSON.parse(result.content) as unknown);
  }

  private async handleUpdateCredentialRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    credentialId: string
  ): Promise<void> {
    let body: Record<string, unknown>;
    try {
      const raw = await this.readJsonBody(request);
      body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    } catch (err) {
      this.respondJson(response, 400, { error_code: "invalid_payload", error_message: err instanceof Error ? err.message : String(err) });
      return;
    }
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const payload: Record<string, unknown> = { credential_id: credentialId };
    for (const key of ["credential_label", "base_url", "model_id", "env_var", "key_value"]) {
      if (body[key] !== undefined) payload[key] = body[key];
    }
    const result = HubResultSchema.parse(
      await this.requestHubForRequest(
        request,
        this.buildHubMessage({
          sessionId,
          intent: "update_credential",
          thread_id: "global",
          target: "global",
          content: JSON.stringify(payload),
          caller: this.extractInboundCaller(request)
        })
      )
    );
    if (result.status !== "success") {
      const errBody = this.parseCredentialErrorBody(result.content);
      this.respondJson(response, this.credentialErrorStatus(errBody.error_code), errBody);
      return;
    }
    this.respondJson(response, 200, JSON.parse(result.content) as unknown);
  }

  private async handleSetDefaultCredentialRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    credentialId: string
  ): Promise<void> {
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const result = HubResultSchema.parse(
      await this.requestHubForRequest(
        request,
        this.buildHubMessage({
          sessionId,
          intent: "set_default_credential",
          thread_id: "global",
          target: "global",
          content: JSON.stringify({ credential_id: credentialId }),
          caller: this.extractInboundCaller(request)
        })
      )
    );
    if (result.status !== "success") {
      const body = this.parseCredentialErrorBody(result.content);
      this.respondJson(response, this.credentialErrorStatus(body.error_code), body);
      return;
    }
    this.respondJson(response, 200, JSON.parse(result.content) as unknown);
  }

  private async handleRegisterApiKeyRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    let body: Record<string, unknown>;
    try {
      const raw = await this.readJsonBody(request);
      body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    } catch (err) {
      this.respondJson(response, 400, { error_code: "invalid_payload", error_message: err instanceof Error ? err.message : String(err) });
      return;
    }
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const result = HubResultSchema.parse(
      await this.requestHubForRequest(
        request,
        this.buildHubMessage({
          sessionId,
          intent: "register_credential_api_key",
          thread_id: "global",
          target: "global",
          content: JSON.stringify(body),
          caller: this.extractInboundCaller(request)
        })
      )
    );
    if (result.status !== "success") {
      const errBody = this.parseCredentialErrorBody(result.content);
      this.respondJson(response, this.credentialErrorStatus(errBody.error_code), errBody);
      return;
    }
    this.respondJson(response, 201, JSON.parse(result.content) as unknown);
  }

  private async handleOAuthLoginStartRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    let body: Record<string, unknown>;
    try {
      const raw = await this.readJsonBody(request);
      body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    } catch (err) {
      this.respondJson(response, 400, { error_code: "invalid_payload", error_message: err instanceof Error ? err.message : String(err) });
      return;
    }
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const result = HubResultSchema.parse(
      await this.requestHubForRequest(
        request,
        this.buildHubMessage({
          sessionId,
          intent: "register_credential_oauth_start",
          thread_id: "global",
          target: "global",
          content: JSON.stringify(body),
          caller: this.extractInboundCaller(request)
        })
      )
    );
    if (result.status !== "success") {
      const errBody = this.parseCredentialErrorBody(result.content);
      this.respondJson(response, this.credentialErrorStatus(errBody.error_code), errBody);
      return;
    }
    this.respondJson(response, 202, JSON.parse(result.content) as unknown);
  }

  private async handleOAuthLoginPollRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    jobId: string
  ): Promise<void> {
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const result = HubResultSchema.parse(
      await this.requestHubForRequest(
        request,
        this.buildHubMessage({
          sessionId,
          intent: "register_credential_oauth_poll",
          thread_id: "global",
          target: "global",
          content: JSON.stringify({ job_id: jobId }),
          caller: this.extractInboundCaller(request)
        })
      )
    );
    if (result.status !== "success") {
      const errBody = this.parseCredentialErrorBody(result.content);
      this.respondJson(response, this.credentialErrorStatus(errBody.error_code), errBody);
      return;
    }
    this.respondJson(response, 200, JSON.parse(result.content) as unknown);
  }

  private async handleOAuthLoginCancelRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    jobId: string
  ): Promise<void> {
    const sessionId = this.resolveSessionId(request, this.getRequestUrl(request), response);
    const result = HubResultSchema.parse(
      await this.requestHubForRequest(
        request,
        this.buildHubMessage({
          sessionId,
          intent: "register_credential_oauth_cancel",
          thread_id: "global",
          target: "global",
          content: JSON.stringify({ job_id: jobId }),
          caller: this.extractInboundCaller(request)
        })
      )
    );
    if (result.status !== "success") {
      const errBody = this.parseCredentialErrorBody(result.content);
      this.respondJson(response, this.credentialErrorStatus(errBody.error_code), errBody);
      return;
    }
    response.statusCode = 204;
    response.end();
  }

  private isPublicStaticAsset(pathname: string): boolean {
    const ext = path.extname(pathname).toLowerCase();
    return [".html", ".js", ".css", ".svg", ".ico", ".txt"].includes(ext) || pathname === "/";
  }

  private isAuthorized(request: http.IncomingMessage, requestUrl: URL): boolean {
    return this.resolveAuthToken(request, requestUrl) === this.token;
  }

  private resolveAuthToken(request: http.IncomingMessage, requestUrl: URL): string {
    const authorization = request.headers.authorization;
    if (typeof authorization === "string") {
      const match = authorization.match(/^Bearer\s+(.+)$/i);
      if (match?.[1]) {
        return match[1].trim();
      }
    }

    return requestUrl.searchParams.get("token")?.trim() ?? "";
  }

  private resolveSessionId(request: http.IncomingMessage, requestUrl: URL, response?: http.ServerResponse): string {
    const headerValue = request.headers["x-session-id"];
    if (typeof headerValue === "string" && headerValue.trim()) {
      return headerValue.trim();
    }

    const queryValue = requestUrl.searchParams.get("session_id")?.trim();
    if (queryValue) {
      return queryValue;
    }

    const cookies = parseCookies(request.headers.cookie);
    const cookieValue = cookies.get(sessionCookieName)?.trim();
    if (cookieValue) {
      return cookieValue;
    }

    const generated = randomUUID();
    if (response && !response.headersSent) {
      response.setHeader("Set-Cookie", `${sessionCookieName}=${generated}; Path=/; HttpOnly; SameSite=Lax`);
    }
    return generated;
  }

  private getRequestUrl(request: http.IncomingMessage): URL {
    return new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  }

  private respondUnauthorized(response: http.ServerResponse, json: boolean): void {
    if (json) {
      this.respondJson(response, 401, { error: "Please provide a valid access token" });
      return;
    }

    response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    response.end("Please provide a valid access token");
  }

  private respondJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
    response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  }

  private friendlyErrorMessage(raw: string): string {
    if (isHubSocketUnreachableMessage(raw)) {
      return "Hub is not reachable — is the hub process running?";
    }
    const lower = raw.toLowerCase();
    if (lower.includes("no active instance") || lower.includes("no active agent") || lower.includes("no registered agent instance found")) {
      return "No active agent session — spawn or attach one first.";
    }
    if (lower.includes("timeout") || lower.includes("timed out")) {
      return "Request timed out — the hub may be overloaded.";
    }
    return `Server error: ${raw}`;
  }

  private async readJsonBody(request: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }

    if (chunks.length === 0) {
      return {};
    }

    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) {
      return {};
    }

    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// Node `net.createConnection` surfaces unix-socket connect failures as
// `connect ENOENT <path>` / `connect ECONNREFUSED <addr>` / `connect ENOTSOCK <path>`.
// The IPC layer (`src/shared/ipc.ts`) emits its own `IPC send connect timed out`
// when even establishing the connection times out. Only these patterns indicate
// the hub socket is genuinely unreachable.
//
// Prior versions matched bare `enoent`/`econnrefused` anywhere in the message,
// which mis-attributed unrelated errors (e.g. `ENOENT: no such file or directory,
// open '<dispatch plan>'`) as a downed hub — leaving agent-dispatcher operators
// staring at "Hub is not reachable" while the hub was healthy and the real cause
// was a missing artifact on disk.
const HUB_SOCKET_UNREACHABLE_PATTERN =
  /\bconnect (?:ENOENT|ECONNREFUSED|ENOTSOCK)\b|\bIPC (?:send|request) connect timed out\b/i;

export function isHubSocketUnreachableMessage(raw: string): boolean {
  return HUB_SOCKET_UNREACHABLE_PATTERN.test(raw);
}

export async function startWebInterfaceServer(options: WebInterfaceServerOptions = {}): Promise<WebInterfaceServer | null> {
  const callerId = "meridian-web";
  const callerKey = deriveBuiltinCallerKey(callerId);
  setCallerIdentity({ caller_id: callerId, caller_key: callerKey, caller_label: "Meridian Web" });
  const server = new WebInterfaceServer(options);
  const started = await server.start();
  return started ? server : null;
}

let standaloneServer: WebInterfaceServer | null = null;

async function stopStandaloneServer(): Promise<void> {
  if (!standaloneServer) {
    return;
  }

  const server = standaloneServer;
  standaloneServer = null;
  await server.stop();
}

if (require.main === module) {
  void startWebInterfaceServer().then((server) => {
    standaloneServer = server;
  });

  process.once("SIGINT", () => {
    void stopStandaloneServer();
  });
  process.once("SIGTERM", () => {
    void stopStandaloneServer();
  });
}
