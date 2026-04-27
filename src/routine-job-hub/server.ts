import * as fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { HubEntry, HubProbeStatus, HubRegistryResult, ProbedHubEntry } from "./types";

export type { HubEntry, HubProbeStatus, HubRegistryResult, ProbedHubEntry } from "./types";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_REGISTRY_PATH = "/Users/yzliu/work/Docs/Projects/routine-job/hub.json";

export interface RoutineJobHubServerOptions {
  host?: string;
  port?: number;
  registryPath?: string;
  probeTimeoutMs?: number;
  log?: Pick<Console, "error" | "info">;
}

export interface RoutineJobHubServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  url(): string;
}

export function createRoutineJobHubServer(options: RoutineJobHubServerOptions = {}): RoutineJobHubServer {
  return new NodeRoutineJobHubServer(options);
}

export function parseHubRegistry(raw: string, sourcePath: string): HubRegistryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      entries: [],
      sourcePath,
      expectedPaths: [sourcePath],
      error: `Invalid hub registry JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      entries: [],
      sourcePath,
      expectedPaths: [sourcePath],
      error: "Invalid hub registry: expected a JSON array"
    };
  }

  const entries: HubEntry[] = [];
  for (const [index, value] of parsed.entries()) {
    const entry = normalizeHubEntry(value);
    if (!entry) {
      return {
        entries: [],
        sourcePath,
        expectedPaths: [sourcePath],
        error: `Invalid hub registry entry at index ${index}: expected id, name, url, and health_path strings`
      };
    }
    entries.push(entry);
  }

  return {
    entries,
    sourcePath,
    expectedPaths: [sourcePath]
  };
}

export async function loadHubRegistry(options: {
  registryPath?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<HubRegistryResult> {
  const expectedPaths = buildRegistryCandidates(options);

  for (const candidate of expectedPaths) {
    try {
      const raw = await fs.readFile(candidate, "utf8");
      const result = parseHubRegistry(raw, candidate);
      return {
        ...result,
        expectedPaths
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }

      return {
        entries: [],
        sourcePath: candidate,
        expectedPaths,
        error: `Unable to read hub registry: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  return {
    entries: [],
    sourcePath: null,
    expectedPaths,
    missing: true,
    error: "Hub registry missing"
  };
}

export async function probeEntry(entry: HubEntry, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<ProbedHubEntry> {
  const healthPath = entry.health_path.trim();
  if (!healthPath) {
    return {
      ...entry,
      status: "disabled"
    };
  }

  const healthUrl = resolveHealthUrl(entry.url, healthPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(healthUrl, {
      method: "HEAD",
      signal: controller.signal
    });
    return {
      ...entry,
      status: response.status === 200 ? "up" : "down",
      health_url: healthUrl,
      status_code: response.status,
      status_message: response.statusText
    };
  } catch (error) {
    return {
      ...entry,
      status: "down",
      health_url: healthUrl,
      status_message: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

class NodeRoutineJobHubServer implements RoutineJobHubServer {
  private readonly host: string;
  private readonly configuredPort: number;
  private readonly registryPath: string | undefined;
  private readonly probeTimeoutMs: number;
  private readonly log: Pick<Console, "error" | "info">;
  private server: Server | null = null;
  private boundPort: number | null = null;

  constructor(options: RoutineJobHubServerOptions) {
    this.host = options.host ?? DEFAULT_HOST;
    this.configuredPort = options.port ?? readPort(process.env.ROUTINE_JOB_HUB_PORT);
    this.registryPath = options.registryPath;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.log = options.log ?? console;
  }

  async listen(): Promise<void> {
    if (this.server) {
      return;
    }

    const server = createServer((request, response) => {
      void this.handle(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.configuredPort, this.host, () => {
        server.removeListener("error", reject);
        const address = server.address();
        this.boundPort = address && typeof address !== "string" ? address.port : this.configuredPort;
        resolve();
      });
    });

    this.server = server;
    this.log.info("Routine Job Hub listening", {
      url: this.url(),
      registryPath: this.registryPath ?? process.env.ROUTINE_JOB_HUB_REGISTRY ?? DEFAULT_REGISTRY_PATH
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    if (!server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  url(): string {
    return `http://${this.host}:${this.boundPort ?? this.configuredPort}`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const pathname = new URL(request.url ?? "/", `http://${this.host}`).pathname;

    try {
      if (pathname === "/api/health" && method === "GET") {
        const registry = await loadHubRegistry({ registryPath: this.registryPath });
        writeJson(response, 200, { status: "ok", entries: registry.entries.length });
        return;
      }

      if (pathname === "/api/entries" && method === "GET") {
        const registry = await loadHubRegistry({ registryPath: this.registryPath });
        const entries = await this.probeEntries(registry.entries);
        writeJson(response, 200, entries);
        return;
      }

      if ((pathname === "/" || pathname === "/index.html") && (method === "GET" || method === "HEAD")) {
        const registry = await loadHubRegistry({ registryPath: this.registryPath });
        const entries = await this.probeEntries(registry.entries);
        const body = renderHubPage(registry, entries);
        writeHtml(response, 200, method === "HEAD" ? "" : body);
        return;
      }

      if (pathname.startsWith("/api/")) {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      writeText(response, 404, "Not found\n");
    } catch (error) {
      this.log.error("Routine Job Hub request failed", {
        url: request.url,
        error: error instanceof Error ? error.message : String(error)
      });

      if (pathname.startsWith("/api/")) {
        writeJson(response, 500, { error: "Internal server error" });
        return;
      }

      writeText(response, 500, "Internal server error\n");
    }
  }

  private async probeEntries(entries: HubEntry[]): Promise<ProbedHubEntry[]> {
    return await Promise.all(entries.map((entry) => probeEntry(entry, this.probeTimeoutMs)));
  }
}

function buildRegistryCandidates(options: { registryPath?: string; env?: NodeJS.ProcessEnv }): string[] {
  if (options.registryPath) {
    return [options.registryPath];
  }

  const env = options.env ?? process.env;
  const candidates = [env.ROUTINE_JOB_HUB_REGISTRY, DEFAULT_REGISTRY_PATH].filter((value): value is string => {
    return Boolean(value?.trim());
  });

  return Array.from(new Set(candidates));
}

function normalizeHubEntry(value: unknown): HubEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string"
    || typeof record.name !== "string"
    || typeof record.url !== "string"
    || typeof record.health_path !== "string"
  ) {
    return null;
  }

  const entry: HubEntry = {
    id: record.id,
    name: record.name,
    url: record.url,
    health_path: record.health_path
  };

  if (typeof record.description === "string" && record.description.trim()) {
    entry.description = record.description;
  }

  return entry;
}

function resolveHealthUrl(baseUrl: string, healthPath: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(healthPath, normalizedBase).toString();
}

function renderHubPage(registry: HubRegistryResult, entries: ProbedHubEntry[]): string {
  const notices = renderRegistryNotices(registry);
  const cards = entries.length > 0
    ? entries.map(renderCard).join("\n")
    : `<section class="empty-state">${registry.missing ? "registry missing" : "No routine-job dashboards registered."}</section>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Routine Job Hub</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f8fb;
        --panel: #ffffff;
        --ink: #172033;
        --muted: #687386;
        --border: #d8dde7;
        --up: #16803c;
        --down: #b42318;
        --disabled: #6b7280;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--ink);
      }
      main {
        max-width: 1080px;
        margin: 0 auto;
        padding: 40px 24px;
      }
      header {
        border-bottom: 1px solid var(--border);
        padding-bottom: 20px;
      }
      h1 {
        margin: 0;
        font-size: 32px;
        font-weight: 700;
        letter-spacing: 0;
      }
      .subtitle {
        color: var(--muted);
        margin: 8px 0 0;
      }
      .notice, .empty-state {
        border: 1px solid var(--border);
        background: var(--panel);
        border-radius: 8px;
        margin-top: 18px;
        padding: 14px 16px;
      }
      .notice strong {
        display: block;
        margin-bottom: 4px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 16px;
        margin-top: 24px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 18px;
      }
      .card-header {
        align-items: flex-start;
        display: flex;
        gap: 12px;
        justify-content: space-between;
      }
      h2 {
        font-size: 18px;
        line-height: 1.25;
        margin: 0;
      }
      .description {
        color: var(--muted);
        min-height: 20px;
        margin: 10px 0 18px;
      }
      .badge {
        align-items: center;
        border-radius: 999px;
        display: inline-flex;
        font-size: 13px;
        gap: 6px;
        line-height: 1;
        padding: 6px 10px;
        white-space: nowrap;
      }
      .badge::before {
        border-radius: 50%;
        content: "";
        display: inline-block;
        height: 8px;
        width: 8px;
      }
      .status-up {
        background: #e9f7ee;
        color: var(--up);
      }
      .status-up::before {
        background: var(--up);
      }
      .status-down {
        background: #fdf0ed;
        color: var(--down);
      }
      .status-down::before {
        background: var(--down);
      }
      .status-disabled {
        background: #eef0f4;
        color: var(--disabled);
      }
      .status-disabled::before {
        background: var(--disabled);
      }
      .actions {
        display: flex;
        gap: 10px;
      }
      a.button {
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--ink);
        display: inline-block;
        font-weight: 600;
        padding: 9px 12px;
        text-decoration: none;
      }
      footer {
        border-top: 1px solid var(--border);
        color: var(--muted);
        font-size: 13px;
        margin-top: 32px;
        padding-top: 16px;
        overflow-wrap: anywhere;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Routine Job Hub</h1>
        <p class="subtitle">Registered routine-job dashboards and live health status.</p>
      </header>
      ${notices}
      <section class="grid" aria-label="Routine job dashboards">
        ${cards}
      </section>
      <footer>Registry source: ${escapeHtml(registry.sourcePath ?? registry.expectedPaths.join(", "))}</footer>
    </main>
  </body>
</html>`;
}

function renderRegistryNotices(registry: HubRegistryResult): string {
  if (registry.missing) {
    return `<section class="notice"><strong>registry missing</strong><span>Expected hub registry at ${escapeHtml(registry.expectedPaths.join(" or "))}.</span></section>`;
  }

  if (registry.error) {
    return `<section class="notice"><strong>Registry error</strong><span>${escapeHtml(registry.error)}</span></section>`;
  }

  return "";
}

function renderCard(entry: ProbedHubEntry): string {
  const statusLabel = getStatusLabel(entry.status, entry.status_code);
  return `<article class="card">
  <div class="card-header">
    <h2>${escapeHtml(entry.name)}</h2>
    <span class="badge status-${entry.status}">${escapeHtml(statusLabel)}</span>
  </div>
  <p class="description">${escapeHtml(entry.description ?? "")}</p>
  <div class="actions">
    <a class="button" href="${escapeAttribute(entry.url)}">Open dashboard</a>
  </div>
</article>`;
}

function getStatusLabel(status: HubProbeStatus, statusCode: number | undefined): string {
  if (status === "up") {
    return "up";
  }

  if (status === "disabled") {
    return "probe disabled";
  }

  return statusCode ? `down ${statusCode}` : "down";
}

function writeHtml(response: ServerResponse, statusCode: number, body: string): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(body);
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function writeText(response: ServerResponse, statusCode: number, body: string): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(body);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("\"", "&quot;");
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function readPort(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_PORT);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535 ? parsed : DEFAULT_PORT;
}

async function main(): Promise<void> {
  const server = createRoutineJobHubServer();
  await server.listen();

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
