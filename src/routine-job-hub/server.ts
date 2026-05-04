import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import type {
  HubEntry,
  HubProbeStatus,
  HubRegistryResult,
  HubRestartResult,
  ProbedHubEntry
} from "./types";

export type {
  HubEntry,
  HubProbeStatus,
  HubRegistryResult,
  HubRestartResult,
  ProbedHubEntry
} from "./types";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_REGISTRY_PATH = "/Users/yzliu/work/Docs/Projects/routine-job/hub.json";
const DEFAULT_RESTART_SCRIPT_ROOTS: readonly string[] = ["/Users/yzliu/work/tools/"];
const DEFAULT_RESTART_TIMEOUT_MS = 180_000;
const RESTART_OUTPUT_MAX_BYTES = 64 * 1024;

export interface RoutineJobHubServerOptions {
  host?: string;
  port?: number;
  registryPath?: string;
  probeTimeoutMs?: number;
  restartTimeoutMs?: number;
  restartScriptRoots?: readonly string[];
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
  private readonly restartTimeoutMs: number;
  private readonly restartScriptRoots: readonly string[];
  private readonly log: Pick<Console, "error" | "info">;
  private server: Server | null = null;
  private boundPort: number | null = null;

  constructor(options: RoutineJobHubServerOptions) {
    this.host = options.host ?? DEFAULT_HOST;
    this.configuredPort = options.port ?? readPort(process.env.ROUTINE_JOB_HUB_PORT);
    this.registryPath = options.registryPath;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.restartTimeoutMs = options.restartTimeoutMs ?? DEFAULT_RESTART_TIMEOUT_MS;
    this.restartScriptRoots = options.restartScriptRoots ?? DEFAULT_RESTART_SCRIPT_ROOTS;
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

      const restartMatch = /^\/api\/entries\/([^/]+)\/restart$/.exec(pathname);
      if (restartMatch && method === "POST") {
        const id = decodeURIComponent(restartMatch[1] ?? "");
        const result = await this.runRestart(id);
        const statusCode = result.status === "ok" ? 200 : result.status === "rejected" ? 400 : 500;
        writeJson(response, statusCode, result);
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

  private async runRestart(id: string): Promise<HubRestartResult> {
    const registry = await loadHubRegistry({ registryPath: this.registryPath });
    const entry = registry.entries.find((candidate) => candidate.id === id);
    if (!entry) {
      return {
        id,
        status: "rejected",
        exit_code: null,
        duration_ms: 0,
        stdout: "",
        stderr: "",
        error: `Unknown entry id: ${id}`
      };
    }

    if (!entry.restart_script) {
      return {
        id,
        status: "rejected",
        exit_code: null,
        duration_ms: 0,
        stdout: "",
        stderr: "",
        error: `Entry ${id} has no restart_script configured`
      };
    }

    const validation = validateRestartScript(entry.restart_script, this.restartScriptRoots);
    if (validation.error) {
      return {
        id,
        status: "rejected",
        exit_code: null,
        duration_ms: 0,
        stdout: "",
        stderr: "",
        error: validation.error
      };
    }

    return await executeRestartScript(id, validation.scriptPath, this.restartTimeoutMs);
  }
}

export function validateRestartScript(
  scriptPath: string,
  allowedRoots: readonly string[]
): { scriptPath: string; error?: undefined } | { scriptPath: ""; error: string } {
  if (!path.isAbsolute(scriptPath)) {
    return { scriptPath: "", error: `restart_script must be an absolute path: ${scriptPath}` };
  }

  const resolved = path.resolve(scriptPath);
  const allowed = allowedRoots.some((root) => {
    const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    return resolved.startsWith(normalizedRoot);
  });

  if (!allowed) {
    return {
      scriptPath: "",
      error: `restart_script ${resolved} is outside the allowed roots: ${allowedRoots.join(", ")}`
    };
  }

  return { scriptPath: resolved };
}

export async function executeRestartScript(
  id: string,
  scriptPath: string,
  timeoutMs: number
): Promise<HubRestartResult> {
  try {
    await fs.access(scriptPath, fs.constants.X_OK);
  } catch (error) {
    return {
      id,
      status: "rejected",
      exit_code: null,
      duration_ms: 0,
      stdout: "",
      stderr: "",
      error: `restart_script ${scriptPath} is not executable: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }

  return await new Promise<HubRestartResult>((resolve) => {
    const startedAt = Date.now();
    const child = spawn(scriptPath, [], {
      cwd: path.dirname(scriptPath),
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killRestartProcess(child.pid, "SIGTERM", () => child.kill("SIGTERM"));
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          killRestartProcess(child.pid, "SIGKILL", () => child.kill("SIGKILL"));
        }
      }, 2_000).unref();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < RESTART_OUTPUT_MAX_BYTES) {
        stdout += chunk.toString("utf8");
        if (stdout.length > RESTART_OUTPUT_MAX_BYTES) {
          stdout = `${stdout.slice(0, RESTART_OUTPUT_MAX_BYTES)}\n…(truncated)`;
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < RESTART_OUTPUT_MAX_BYTES) {
        stderr += chunk.toString("utf8");
        if (stderr.length > RESTART_OUTPUT_MAX_BYTES) {
          stderr = `${stderr.slice(0, RESTART_OUTPUT_MAX_BYTES)}\n…(truncated)`;
        }
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        id,
        status: "failed",
        exit_code: null,
        duration_ms: Date.now() - startedAt,
        stdout,
        stderr,
        error: error instanceof Error ? error.message : String(error)
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const duration = Date.now() - startedAt;
      if (timedOut) {
        resolve({
          id,
          status: "failed",
          exit_code: null,
          duration_ms: duration,
          stdout,
          stderr,
          error: `restart_script timed out after ${timeoutMs}ms`
        });
        return;
      }

      const exitCode = code ?? null;
      resolve({
        id,
        status: exitCode === 0 ? "ok" : "failed",
        exit_code: exitCode,
        duration_ms: duration,
        stdout,
        stderr,
        error: exitCode === 0
          ? undefined
          : signal
            ? `restart_script terminated by signal ${signal}`
            : `restart_script exited with code ${exitCode}`
      });
    });
  });
}

function killRestartProcess(pid: number | undefined, signal: NodeJS.Signals, fallback: () => boolean): void {
  if (pid === undefined) {
    fallback();
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    fallback();
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

  if (typeof record.public_url === "string" && record.public_url.trim()) {
    entry.public_url = record.public_url.trim();
  }

  if (typeof record.gui_port === "number" && Number.isInteger(record.gui_port) && record.gui_port > 0) {
    entry.gui_port = record.gui_port;
  }

  if (typeof record.action_label === "string" && record.action_label.trim()) {
    entry.action_label = record.action_label.trim();
  }

  if (typeof record.restart_script === "string" && record.restart_script.trim()) {
    entry.restart_script = record.restart_script.trim();
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
        margin: 10px 0 12px;
      }
      .route-list {
        border-top: 1px solid var(--border);
        display: grid;
        gap: 6px;
        margin: 0 0 16px;
        padding-top: 12px;
      }
      .route-row {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      .route-row strong {
        color: var(--ink);
        font-weight: 700;
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
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      a.button, button.button {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--ink);
        cursor: pointer;
        display: inline-block;
        font: inherit;
        font-weight: 600;
        padding: 9px 12px;
        text-decoration: none;
      }
      button.button[disabled] {
        cursor: progress;
        opacity: 0.6;
      }
      .restart-status {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.3;
        margin-top: 8px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .restart-status.ok { color: var(--up); }
      .restart-status.err { color: var(--down); }
      .restart-status pre {
        background: #0b1020;
        border-radius: 6px;
        color: #e6edf3;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        margin-top: 6px;
        max-height: 220px;
        overflow: auto;
        padding: 8px 10px;
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
    ${RESTART_CLIENT_SCRIPT}
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
  const actionLabel = entry.action_label ?? "Rebuild & restart";
  const restartButton = entry.restart_script
    ? `\n    <button type="button" class="button" data-restart-id="${escapeAttribute(entry.id)}">${escapeHtml(actionLabel)}</button>`
    : "";
  const restartStatus = entry.restart_script
    ? `\n  <p class="restart-status" data-restart-status="${escapeAttribute(entry.id)}" hidden></p>`
    : "";
  const routeList = renderRouteList(entry);
  return `<article class="card">
  <div class="card-header">
    <h2>${escapeHtml(entry.name)}</h2>
    <span class="badge status-${entry.status}">${escapeHtml(statusLabel)}</span>
  </div>
  <p class="description">${escapeHtml(entry.description ?? "")}</p>
  ${routeList}
  <div class="actions">
    <a class="button" href="${escapeAttribute(entry.url)}">Open dashboard</a>${restartButton}
  </div>${restartStatus}
</article>`;
}

function renderRouteList(entry: ProbedHubEntry): string {
  const rows = [
    renderRouteRow("Local URL", entry.url),
    entry.public_url ? renderRouteRow("Public URL", entry.public_url) : "",
    entry.gui_port ? renderRouteRow("GUI URLs", getGuiUrls(entry.gui_port).join(", ")) : ""
  ].filter(Boolean);

  return rows.length > 0 ? `<div class="route-list">${rows.join("")}</div>` : "";
}

function renderRouteRow(label: string, value: string): string {
  return `<div class="route-row"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</div>`;
}

function getGuiUrls(port: number): string[] {
  const hosts = new Set<string>();
  hosts.add("127.0.0.1");

  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const networkInterface of interfaces ?? []) {
      if (networkInterface.family === "IPv4" && !networkInterface.internal) {
        hosts.add(networkInterface.address);
      }
    }
  }

  return Array.from(hosts).map((host) => `http://${host}:${port}`);
}

const RESTART_CLIENT_SCRIPT = `<script>
(function () {
  const buttons = document.querySelectorAll('button[data-restart-id]');
  buttons.forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.getAttribute('data-restart-id');
      if (!id) return;
      const status = document.querySelector(
        '[data-restart-status="' + CSS.escape(id) + '"]'
      );
      button.disabled = true;
      const originalLabel = button.textContent;
      button.textContent = 'Running...';
      if (status) {
        status.hidden = false;
        status.classList.remove('ok', 'err');
        status.textContent = 'Running ' + id + ' script...';
      }
      try {
        const res = await fetch(
          '/api/entries/' + encodeURIComponent(id) + '/restart',
          { method: 'POST' }
        );
        const data = await res.json().catch(() => ({}));
        const ok = res.ok && data.status === 'ok';
        if (status) {
          status.classList.toggle('ok', ok);
          status.classList.toggle('err', !ok);
          const summary = ok
            ? 'Restart OK · ' + (data.duration_ms || 0) + 'ms'
            : 'Restart failed: ' + (data.error || 'exit ' + data.exit_code);
          const detail = (data.stdout || '') + (data.stderr ? '\\n' + data.stderr : '');
          status.innerHTML = '';
          const head = document.createElement('span');
          head.textContent = summary;
          status.appendChild(head);
          if (detail.trim()) {
            const pre = document.createElement('pre');
            pre.textContent = detail.trim();
            status.appendChild(pre);
          }
        }
      } catch (error) {
        if (status) {
          status.classList.add('err');
          status.textContent = 'Restart request failed: ' +
            (error && error.message ? error.message : String(error));
        }
      } finally {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    });
  });
})();
</script>`;

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
