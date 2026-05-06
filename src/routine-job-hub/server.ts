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
const DEFAULT_CLAWSO_REPO_ROOT = "/Users/yzliu/work/projects/clawso-v3-build";
export const DEFAULT_RESTART_SCRIPT_ROOTS: readonly string[] = [
  "/Users/yzliu/work/tools/",
  "/Users/yzliu/work/projects/ADS/user_scripts/",
  "/Users/yzliu/work/Meridian/user_scripts/",
  "/Users/yzliu/work/Meridian/Meridian-roles/user_scripts/"
];
const DEFAULT_RESTART_TIMEOUT_MS = 180_000;
const DEFAULT_CLAWSO_SCRIPT_TIMEOUT_MS = 45 * 60_000;
const RESTART_OUTPUT_MAX_BYTES = 64 * 1024;
const CLAWSO_OUTPUT_MAX_BYTES = 256 * 1024;

type ClawsoBuildModeId = "debug" | "local" | "online" | "webwrap";
type ClawsoBuildArtifactType = "app" | "dmg" | "url";
type ClawsoSizeReader = (absolutePath: string) => Promise<number>;
type ClawsoArtifactOpener = (artifactPath: string) => Promise<void>;
type ClawsoBranchReader = (repoRoot: string) => Promise<string>;

interface ClawsoBuildMode {
  id: ClawsoBuildModeId;
  modeNumber: number;
  title: string;
  actionLabel: string;
  scriptRelPath: string;
  args: string[];
  artifactType: ClawsoBuildArtifactType;
  artifactRelPath?: string;
  artifactDirRelPath?: string;
  artifactUrl?: string;
  description: string;
  requiresOnlineConfirmation?: boolean;
}

interface ClawsoBuildArtifact {
  bytes: number | null;
  name: string;
  path: string;
  type: ClawsoBuildArtifactType;
  updatedAt: string;
}

interface ClawsoBuildModeStatus {
  artifact: ClawsoBuildArtifact | null;
  artifactType: ClawsoBuildArtifactType;
  available: boolean;
  branch: string;
  description: string;
  id: ClawsoBuildModeId;
  modeNumber: number;
  artifactUrl?: string;
  scriptDirectory: string;
  scriptDirectoryDisplay: string;
  scriptPath: string;
  scriptRelPath: string;
  title: string;
  actionLabel: string;
  unavailableReason?: string;
}

interface ClawsoBuildFootprintEntry {
  bytes: number;
  formattedBytes: string;
  id: string;
  label: string;
  path: string;
  relPath: string;
}

interface ClawsoBuildFootprint {
  formattedTotal: string;
  paths: ClawsoBuildFootprintEntry[];
  totalBytes: number;
}

interface ClawsoMaintenanceStatus {
  footprint: ClawsoBuildFootprint;
  modes: ClawsoBuildModeStatus[];
  repoRoot: string;
}

interface ClawsoBuildResult {
  artifact: ClawsoBuildArtifact | null;
  duration_ms: number;
  error?: string;
  exit_code: number | null;
  mode: ClawsoBuildModeId;
  status: "failed" | "ok" | "rejected";
  stderr: string;
  stdout: string;
}

interface ClawsoActivateResult {
  artifact: ClawsoBuildArtifact | null;
  error?: string;
  mode: ClawsoBuildModeId;
  status: "ok" | "rejected";
}

const CLAWSO_BUILD_MODES: readonly ClawsoBuildMode[] = [
  {
    id: "debug",
    modeNumber: 1,
    title: "Debug app",
    actionLabel: "Build debug app",
    scriptRelPath: "user_scripts/release-desktop-client--debug.sh",
    args: ["--yes"],
    artifactType: "app",
    artifactRelPath: "apps/client/src-tauri/target/debug/bundle/macos/Clawso.app",
    description: "Fast .app bundle, no codesign, no notarization, no DMG."
  },
  {
    id: "local",
    modeNumber: 2,
    title: "Local validation DMG",
    actionLabel: "Build local DMG",
    scriptRelPath: "user_scripts/release-desktop-client--local.sh",
    args: ["--yes"],
    artifactType: "dmg",
    artifactDirRelPath: "apps/client/src-tauri/target/release/bundle/dmg",
    description: "Codesigned and notarized DMG, no uploads."
  },
  {
    id: "online",
    modeNumber: 3,
    title: "Online release",
    actionLabel: "Run online release",
    scriptRelPath: "user_scripts/release-desktop-client.sh",
    args: ["--yes"],
    artifactType: "dmg",
    artifactDirRelPath: "apps/client/src-tauri/target/release/bundle/dmg",
    description: "Full Supabase, GitHub, Cloudflare, and manifest release pipeline.",
    requiresOnlineConfirmation: true
  },
  {
    id: "webwrap",
    modeNumber: 4,
    title: "Web-app wrapper",
    actionLabel: "Build local web view",
    scriptRelPath: "user_scripts/release-desktop-client--webwrap.sh",
    args: ["--no-deploy", "--yes"],
    artifactType: "url",
    artifactRelPath: ".dist/client-webwrap",
    artifactUrl: "http://127.0.0.1:5173/",
    description: "Builds the apps/client SPA plus Pages Functions worker for local browser testing; no Cloudflare deploy."
  }
];

const CLAWSO_BUILD_FOOTPRINT_PATHS: ReadonlyArray<{ id: string; label: string; relPath: string }> = [
  { id: "tauri-target", label: "Tauri target", relPath: "apps/client/src-tauri/target" },
  { id: "client-dist", label: "Client dist", relPath: "apps/client/dist" },
  { id: "release-logs", label: "Release logs", relPath: ".dist/release-logs" }
];

export interface RoutineJobHubServerOptions {
  host?: string;
  port?: number;
  registryPath?: string;
  probeTimeoutMs?: number;
  restartTimeoutMs?: number;
  restartScriptRoots?: readonly string[];
  clawsoRepoRoot?: string;
  clawsoScriptTimeoutMs?: number;
  clawsoSizeReader?: ClawsoSizeReader;
  clawsoBranchReader?: ClawsoBranchReader;
  clawsoArtifactOpener?: ClawsoArtifactOpener;
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
  private readonly clawsoRepoRoot: string;
  private readonly clawsoScriptTimeoutMs: number;
  private readonly clawsoSizeReader: ClawsoSizeReader;
  private readonly clawsoBranchReader: ClawsoBranchReader;
  private readonly clawsoArtifactOpener: ClawsoArtifactOpener;
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
    this.clawsoRepoRoot = path.resolve(options.clawsoRepoRoot ?? DEFAULT_CLAWSO_REPO_ROOT);
    this.clawsoScriptTimeoutMs = options.clawsoScriptTimeoutMs ?? DEFAULT_CLAWSO_SCRIPT_TIMEOUT_MS;
    this.clawsoSizeReader = options.clawsoSizeReader ?? readDirectorySizeWithDu;
    this.clawsoBranchReader = options.clawsoBranchReader ?? readGitBranch;
    this.clawsoArtifactOpener = options.clawsoArtifactOpener ?? openArtifactWithSystem;
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

      if (pathname === "/api/clawso-desktop-maintenance" && method === "GET") {
        const status = await buildClawsoDesktopMaintenanceStatus(
          this.clawsoRepoRoot,
          this.clawsoSizeReader,
          this.clawsoBranchReader
        );
        writeJson(response, 200, status);
        return;
      }

      if (pathname === "/api/clawso-desktop-maintenance/build" && method === "POST") {
        const body = await readJsonBody(request);
        const confirmOnlineRelease = Boolean(
          body && typeof body === "object" && (body as { confirmOnlineRelease?: unknown }).confirmOnlineRelease
        );
        const result = await runClawsoDesktopBuild(
          this.clawsoRepoRoot,
          readRequestedClawsoMode(body),
          this.clawsoScriptTimeoutMs,
          confirmOnlineRelease
        );
        const statusCode = result.status === "ok" ? 200 : result.status === "rejected" ? 400 : 500;
        writeJson(response, statusCode, result);
        return;
      }

      if (pathname === "/api/clawso-desktop-maintenance/activate" && method === "POST") {
        const body = await readJsonBody(request);
        const result = await activateClawsoDesktopArtifact(
          this.clawsoRepoRoot,
          readRequestedClawsoMode(body),
          this.clawsoArtifactOpener
        );
        const statusCode = result.status === "ok" ? 200 : 400;
        writeJson(response, statusCode, result);
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

      const terminateMatch = /^\/api\/entries\/([^/]+)\/terminate$/.exec(pathname);
      if (terminateMatch && method === "POST") {
        const id = decodeURIComponent(terminateMatch[1] ?? "");
        const result = await this.runTerminate(id);
        const statusCode = result.status === "ok" ? 200 : result.status === "rejected" ? 400 : 500;
        writeJson(response, statusCode, result);
        return;
      }

      if ((pathname === "/" || pathname === "/index.html") && (method === "GET" || method === "HEAD")) {
        const registry = await loadHubRegistry({ registryPath: this.registryPath });
        const entries = await this.probeEntries(registry.entries);
        const clawsoStatus = await buildClawsoDesktopMaintenanceStatus(
          this.clawsoRepoRoot,
          this.clawsoSizeReader,
          this.clawsoBranchReader
        );
        const body = renderHubPage(registry, entries, clawsoStatus);
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
    return await this.runScript(id, "restart_script");
  }

  private async runTerminate(id: string): Promise<HubRestartResult> {
    return await this.runScript(id, "terminate_script");
  }

  private async runScript(id: string, scriptField: "restart_script" | "terminate_script"): Promise<HubRestartResult> {
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

    const scriptPath = entry[scriptField];
    if (!scriptPath) {
      return {
        id,
        status: "rejected",
        exit_code: null,
        duration_ms: 0,
        stdout: "",
        stderr: "",
        error: `Entry ${id} has no ${scriptField} configured`
      };
    }

    const validation = validateScriptPath(scriptPath, this.restartScriptRoots, scriptField);
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

    return await executeScript(id, validation.scriptPath, this.restartTimeoutMs, scriptField);
  }
}

export function validateRestartScript(
  scriptPath: string,
  allowedRoots: readonly string[]
): { scriptPath: string; error?: undefined } | { scriptPath: ""; error: string } {
  return validateScriptPath(scriptPath, allowedRoots, "restart_script");
}

function validateScriptPath(
  scriptPath: string,
  allowedRoots: readonly string[],
  scriptField: "restart_script" | "terminate_script"
): { scriptPath: string; error?: undefined } | { scriptPath: ""; error: string } {
  if (!path.isAbsolute(scriptPath)) {
    return { scriptPath: "", error: `${scriptField} must be an absolute path: ${scriptPath}` };
  }

  const resolved = path.resolve(scriptPath);
  const allowed = allowedRoots.some((root) => {
    const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    return resolved.startsWith(normalizedRoot);
  });

  if (!allowed) {
    return {
      scriptPath: "",
      error: `${scriptField} ${resolved} is outside the allowed roots: ${allowedRoots.join(", ")}`
    };
  }

  return { scriptPath: resolved };
}

export async function executeRestartScript(
  id: string,
  scriptPath: string,
  timeoutMs: number
): Promise<HubRestartResult> {
  return await executeScript(id, scriptPath, timeoutMs, "restart_script");
}

async function executeScript(
  id: string,
  scriptPath: string,
  timeoutMs: number,
  scriptField: "restart_script" | "terminate_script"
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
      error: `${scriptField} ${scriptPath} is not executable: ${
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
      killScriptProcess(child.pid, "SIGTERM", () => child.kill("SIGTERM"));
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          killScriptProcess(child.pid, "SIGKILL", () => child.kill("SIGKILL"));
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
          error: `${scriptField} timed out after ${timeoutMs}ms`
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
            ? `${scriptField} terminated by signal ${signal}`
            : `${scriptField} exited with code ${exitCode}`
      });
    });
  });
}

export function formatClawsoBuildBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function formatClawsoDisplayPath(absolutePath: string): string {
  const resolved = path.resolve(absolutePath);
  const home = os.homedir();
  if (resolved === home) {
    return "~";
  }

  if (resolved.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, resolved).split(path.sep).join("/")}`;
  }

  return resolved;
}

async function buildClawsoDesktopMaintenanceStatus(
  repoRoot: string,
  sizeReader: ClawsoSizeReader,
  branchReader: ClawsoBranchReader
): Promise<ClawsoMaintenanceStatus> {
  const branch = await branchReader(repoRoot);
  const [modes, footprint] = await Promise.all([
    Promise.all(CLAWSO_BUILD_MODES.map((mode) => getClawsoBuildModeStatus(repoRoot, mode, branch))),
    collectClawsoBuildFootprint(repoRoot, sizeReader)
  ]);

  return {
    footprint,
    modes,
    repoRoot
  };
}

async function collectClawsoBuildFootprint(
  repoRoot: string,
  sizeReader: ClawsoSizeReader
): Promise<ClawsoBuildFootprint> {
  const paths = await Promise.all(
    CLAWSO_BUILD_FOOTPRINT_PATHS.map(async (entry) => {
      const absolutePath = path.join(repoRoot, entry.relPath);
      const bytes = await sizeReader(absolutePath);
      return {
        ...entry,
        bytes,
        formattedBytes: formatClawsoBuildBytes(bytes),
        path: absolutePath
      };
    })
  );
  const totalBytes = paths.reduce((sum, entry) => sum + entry.bytes, 0);

  return {
    formattedTotal: formatClawsoBuildBytes(totalBytes),
    paths,
    totalBytes
  };
}

async function getClawsoBuildModeStatus(
  repoRoot: string,
  mode: ClawsoBuildMode,
  branch: string
): Promise<ClawsoBuildModeStatus> {
  const scriptPath = path.join(repoRoot, mode.scriptRelPath);
  const scriptDirectory = path.dirname(scriptPath);
  const scriptCheck = await checkClawsoScript(scriptPath, mode.scriptRelPath);
  return {
    artifact: await findClawsoArtifact(repoRoot, mode.id),
    artifactType: mode.artifactType,
    available: scriptCheck.available,
    branch,
    description: mode.description,
    id: mode.id,
    modeNumber: mode.modeNumber,
    artifactUrl: mode.artifactUrl,
    scriptDirectory,
    scriptDirectoryDisplay: formatClawsoDisplayPath(scriptDirectory),
    scriptPath,
    scriptRelPath: mode.scriptRelPath,
    title: mode.title,
    actionLabel: mode.actionLabel,
    unavailableReason: scriptCheck.unavailableReason
  };
}

async function checkClawsoScript(
  scriptPath: string,
  scriptRelPath: string
): Promise<{ available: true; unavailableReason?: undefined } | { available: false; unavailableReason: string }> {
  try {
    const info = await fs.stat(scriptPath);
    if (!info.isFile()) {
      return { available: false, unavailableReason: `Script path is not a file: ${scriptRelPath}` };
    }
    return { available: true };
  } catch {
    return { available: false, unavailableReason: `Missing script: ${scriptRelPath}` };
  }
}

async function findClawsoArtifact(repoRoot: string, modeId: ClawsoBuildModeId): Promise<ClawsoBuildArtifact | null> {
  const mode = getClawsoMode(modeId);
  if (mode.artifactType === "app" || mode.artifactType === "url") {
    const appPath = path.join(repoRoot, mode.artifactRelPath ?? "");
    try {
      const info = await fs.stat(appPath);
      if (!info.isDirectory()) {
        return null;
      }
      return {
        bytes: null,
        name: mode.artifactUrl ?? path.basename(appPath),
        path: mode.artifactUrl ?? appPath,
        type: mode.artifactType,
        updatedAt: info.mtime.toISOString()
      };
    } catch {
      return null;
    }
  }

  const dmgDir = path.join(repoRoot, mode.artifactDirRelPath ?? "");
  let entries: Array<{
    artifact: ClawsoBuildArtifact;
    mtimeMs: number;
  }> = [];
  try {
    const dirents = await fs.readdir(dmgDir, { withFileTypes: true });
    entries = await Promise.all(
      dirents
        .filter((entry) => entry.isFile() && entry.name.endsWith(".dmg"))
        .map(async (entry) => {
          const artifactPath = path.join(dmgDir, entry.name);
          const info = await fs.stat(artifactPath);
          return {
            artifact: {
              bytes: info.size,
              name: entry.name,
              path: artifactPath,
              type: "dmg" as const,
              updatedAt: info.mtime.toISOString()
            },
            mtimeMs: info.mtimeMs
          };
        })
    );
  } catch {
    return null;
  }

  entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return entries[0]?.artifact ?? null;
}

function getClawsoMode(modeId: ClawsoBuildModeId): ClawsoBuildMode {
  const mode = CLAWSO_BUILD_MODES.find((candidate) => candidate.id === modeId);
  if (!mode) {
    throw new Error(`Unknown Clawso desktop build mode: ${modeId}`);
  }
  return mode;
}

function readRequestedClawsoMode(body: unknown): ClawsoBuildModeId {
  if (!body || typeof body !== "object") {
    return "local";
  }

  const mode = (body as { mode?: unknown }).mode;
  return mode === "debug" || mode === "local" || mode === "online" || mode === "webwrap" ? mode : "local";
}

async function runClawsoDesktopBuild(
  repoRoot: string,
  modeId: ClawsoBuildModeId,
  timeoutMs: number,
  confirmOnlineRelease: boolean
): Promise<ClawsoBuildResult> {
  const mode = getClawsoMode(modeId);
  const scriptPath = path.join(repoRoot, mode.scriptRelPath);
  const scriptCheck = await checkClawsoScript(scriptPath, mode.scriptRelPath);
  if (!scriptCheck.available) {
    return {
      artifact: await findClawsoArtifact(repoRoot, mode.id),
      duration_ms: 0,
      error: scriptCheck.unavailableReason,
      exit_code: null,
      mode: mode.id,
      status: "rejected",
      stderr: "",
      stdout: ""
    };
  }

  if (mode.requiresOnlineConfirmation && !confirmOnlineRelease) {
    return {
      artifact: await findClawsoArtifact(repoRoot, mode.id),
      duration_ms: 0,
      error: "Online release requires explicit confirmation",
      exit_code: null,
      mode: mode.id,
      status: "rejected",
      stderr: "",
      stdout: ""
    };
  }

  return await executeClawsoBuildScript(repoRoot, mode, scriptPath, timeoutMs);
}

async function executeClawsoBuildScript(
  repoRoot: string,
  mode: ClawsoBuildMode,
  scriptPath: string,
  timeoutMs: number
): Promise<ClawsoBuildResult> {
  return await new Promise<ClawsoBuildResult>((resolve) => {
    const startedAt = Date.now();
    const child = spawn("/bin/bash", [scriptPath, ...mode.args], {
      cwd: repoRoot,
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const appendOutput = (current: string, chunk: Buffer): string => {
      if (current.length >= CLAWSO_OUTPUT_MAX_BYTES) {
        return current;
      }
      const next = current + chunk.toString("utf8");
      return next.length > CLAWSO_OUTPUT_MAX_BYTES
        ? `${next.slice(0, CLAWSO_OUTPUT_MAX_BYTES)}\n…(truncated)`
        : next;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killScriptProcess(child.pid, "SIGTERM", () => child.kill("SIGTERM"));
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          killScriptProcess(child.pid, "SIGKILL", () => child.kill("SIGKILL"));
        }
      }, 2_000).unref();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
    });

    child.on("error", async (error) => {
      clearTimeout(timer);
      resolve({
        artifact: await findClawsoArtifact(repoRoot, mode.id),
        duration_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        exit_code: null,
        mode: mode.id,
        status: "failed",
        stderr,
        stdout
      });
    });

    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      const duration = Date.now() - startedAt;
      const artifact = await findClawsoArtifact(repoRoot, mode.id);
      if (timedOut) {
        resolve({
          artifact,
          duration_ms: duration,
          error: `${mode.title} timed out after ${timeoutMs}ms`,
          exit_code: null,
          mode: mode.id,
          status: "failed",
          stderr,
          stdout
        });
        return;
      }

      const exitCode = code ?? null;
      resolve({
        artifact,
        duration_ms: duration,
        error: exitCode === 0
          ? undefined
          : signal
            ? `${mode.title} terminated by signal ${signal}`
            : `${mode.title} exited with code ${exitCode}`,
        exit_code: exitCode,
        mode: mode.id,
        status: exitCode === 0 ? "ok" : "failed",
        stderr,
        stdout
      });
    });
  });
}

async function activateClawsoDesktopArtifact(
  repoRoot: string,
  modeId: ClawsoBuildModeId,
  artifactOpener: ClawsoArtifactOpener
): Promise<ClawsoActivateResult> {
  const artifact = await findClawsoArtifact(repoRoot, modeId);
  if (!artifact) {
    return {
      artifact: null,
      error: `No generated artifact found for ${modeId}`,
      mode: modeId,
      status: "rejected"
    };
  }

  await artifactOpener(artifact.path);
  return {
    artifact,
    mode: modeId,
    status: "ok"
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as unknown;
}

async function readDirectorySizeWithDu(absolutePath: string): Promise<number> {
  try {
    await fs.access(absolutePath);
  } catch {
    return 0;
  }

  return await new Promise<number>((resolve) => {
    const child = spawn("du", ["-sk", absolutePath], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => resolve(0));
    child.on("close", () => {
      const blocks = Number.parseInt(stdout.trim().split(/\s+/u)[0] ?? "0", 10);
      resolve(Number.isFinite(blocks) ? blocks * 1024 : 0);
    });
  });
}

async function readGitBranch(repoRoot: string): Promise<string> {
  const branch = await readGitOutput(["-C", repoRoot, "branch", "--show-current"]);
  if (branch) {
    return branch;
  }

  const sha = await readGitOutput(["-C", repoRoot, "rev-parse", "--short", "HEAD"]);
  return sha ? `detached:${sha}` : "unknown";
}

async function readGitOutput(args: string[]): Promise<string> {
  return await new Promise<string>((resolve) => {
    const child = spawn("git", args, {
      stdio: ["ignore", "pipe", "ignore"]
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => resolve(""));
    child.on("close", (code) => {
      resolve(code === 0 ? stdout.trim() : "");
    });
  });
}

async function openArtifactWithSystem(artifactPath: string): Promise<void> {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/C", "start", "", artifactPath] : [artifactPath];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("spawn", resolve);
    child.unref();
  });
}

function killScriptProcess(pid: number | undefined, signal: NodeJS.Signals, fallback: () => boolean): void {
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

  if (typeof record.terminate_script === "string" && record.terminate_script.trim()) {
    entry.terminate_script = record.terminate_script.trim();
  }

  return entry;
}

function resolveHealthUrl(baseUrl: string, healthPath: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(healthPath, normalizedBase).toString();
}

function renderHubPage(
  registry: HubRegistryResult,
  entries: ProbedHubEntry[],
  clawsoStatus: ClawsoMaintenanceStatus
): string {
  const notices = renderRegistryNotices(registry);
  const clawsoCard = renderClawsoDesktopMaintenanceCard(clawsoStatus);
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
      .maintenance-card {
        margin-top: 22px;
      }
      .maintenance-topline {
        align-items: start;
        display: grid;
        gap: 16px;
        grid-template-columns: minmax(0, 1fr) minmax(240px, 0.34fr);
      }
      .maintenance-topline > div,
      .maintenance-modes,
      .maintenance-mode {
        min-width: 0;
      }
      .maintenance-total {
        font-size: 30px;
        font-weight: 800;
        margin: 6px 0 0;
      }
      .maintenance-breakdown {
        display: grid;
        gap: 7px;
        margin-top: 10px;
      }
      .maintenance-breakdown-row {
        color: var(--muted);
        display: flex;
        font-size: 13px;
        gap: 12px;
        justify-content: space-between;
      }
      .maintenance-modes {
        align-items: start;
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        margin-top: 16px;
      }
      .maintenance-mode {
        align-content: start;
        border: 1px solid var(--border);
        border-radius: 8px;
        display: grid;
        gap: 10px;
        padding: 12px;
      }
      .maintenance-mode h3 {
        font-size: 15px;
        margin: 0;
      }
      .maintenance-artifact {
        color: var(--muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        min-height: 16px;
        overflow-wrap: anywhere;
      }
      .maintenance-status {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.35;
        margin: 0;
        min-width: 0;
        overflow: hidden;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .maintenance-status.ok { color: var(--up); }
      .maintenance-status.err { color: var(--down); }
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
      .restart-status pre,
      .maintenance-status pre {
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
      .maintenance-status pre {
        box-sizing: border-box;
        max-width: 100%;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
        word-break: break-word;
      }
      footer {
        border-top: 1px solid var(--border);
        color: var(--muted);
        font-size: 13px;
        margin-top: 32px;
        padding-top: 16px;
        overflow-wrap: anywhere;
      }
      @media (max-width: 780px) {
        main {
          padding: 28px 16px;
        }
        .maintenance-topline,
        .maintenance-modes {
          grid-template-columns: 1fr;
        }
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
      ${clawsoCard}
      <section class="grid" aria-label="Routine job dashboards">
        ${cards}
      </section>
      <footer>Registry source: ${escapeHtml(registry.sourcePath ?? registry.expectedPaths.join(", "))}</footer>
    </main>
    ${RESTART_CLIENT_SCRIPT}
    ${CLAWSO_MAINTENANCE_CLIENT_SCRIPT}
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

function renderClawsoDesktopMaintenanceCard(status: ClawsoMaintenanceStatus): string {
  const breakdown = status.footprint.paths
    .map((entry) => `<div class="maintenance-breakdown-row" data-clawso-footprint-path="${escapeAttribute(entry.id)}"><span>${escapeHtml(entry.label)}</span><strong>${escapeHtml(entry.formattedBytes)}</strong></div>`)
    .join("");
  const modes = status.modes.map(renderClawsoMaintenanceMode).join("\n");

  return `<section class="card maintenance-card" aria-labelledby="clawso-desktop-maintenance-heading">
  <div class="maintenance-topline">
    <div>
      <h2 id="clawso-desktop-maintenance-heading">Clawso Desktop Maintenance</h2>
      <p class="description">Local desktop-client build control for debug, local validation, and online release modes.</p>
    </div>
    <div>
      <div class="route-row"><strong>Repo:</strong> ${escapeHtml(formatClawsoDisplayPath(status.repoRoot))}</div>
      <div class="maintenance-total" data-clawso-footprint-total>${escapeHtml(status.footprint.formattedTotal)}</div>
      <div class="maintenance-breakdown">${breakdown}</div>
    </div>
  </div>
  <div class="maintenance-modes">
    ${modes}
  </div>
</section>`;
}

function renderClawsoMaintenanceMode(mode: ClawsoBuildModeStatus): string {
  const availability = mode.available
    ? `<span class="badge status-up">ready</span>`
    : `<span class="badge status-down">unavailable</span>`;
  const artifact = mode.artifact
    ? `${mode.artifact.path}${mode.artifact.bytes === null ? "" : ` (${formatClawsoBuildBytes(mode.artifact.bytes)})`}`
    : "No artifact detected yet.";
  const disabled = mode.available ? "" : " disabled";
  const activateDisabled = mode.artifact ? "" : " disabled";
  const unavailable = mode.unavailableReason
    ? `<p class="maintenance-status err">${escapeHtml(mode.unavailableReason)}</p>`
    : "";
  const modeMeta = `<div class="route-list">
    <div class="route-row"><strong>Branch:</strong> ${escapeHtml(mode.branch)}</div>
    <div class="route-row"><strong>Script:</strong> ${escapeHtml(mode.scriptRelPath)}</div>
    <div class="route-row"><strong>Script dir:</strong> ${escapeHtml(mode.scriptDirectoryDisplay)}</div>
  </div>`;

  return `<article class="maintenance-mode">
  <div class="card-header">
    <h3>Mode ${mode.modeNumber}: ${escapeHtml(mode.title)}</h3>
    ${availability}
  </div>
  <p class="description">${escapeHtml(mode.description)}</p>
  ${modeMeta}
  ${unavailable}
  <p class="maintenance-artifact" data-clawso-artifact="${escapeAttribute(mode.id)}">${escapeHtml(artifact)}</p>
  <div class="actions">
    <button type="button" class="button" data-clawso-build-mode="${escapeAttribute(mode.id)}"${disabled}>${escapeHtml(mode.actionLabel)}</button>
    <button type="button" class="button" data-clawso-activate-mode="${escapeAttribute(mode.id)}"${activateDisabled}>Activate</button>
  </div>
  <div class="maintenance-status" data-clawso-status="${escapeAttribute(mode.id)}" data-clawso-command-log="${escapeAttribute(mode.id)}" aria-live="polite" hidden></div>
</article>`;
}

function renderCard(entry: ProbedHubEntry): string {
  const statusLabel = getStatusLabel(entry.status, entry.status_code);
  const actionLabel = entry.action_label ?? "Rebuild & restart";
  const restartButton = entry.restart_script
    ? `\n    <button type="button" class="button" data-script-action="restart" data-restart-id="${escapeAttribute(entry.id)}">${escapeHtml(actionLabel)}</button>`
    : "";
  const terminateButton = entry.terminate_script
    ? `\n    <button type="button" class="button" data-script-action="terminate" data-terminate-id="${escapeAttribute(entry.id)}">Terminate</button>`
    : "";
  const restartStatus = entry.restart_script || entry.terminate_script
    ? `\n  <p class="restart-status" data-restart-status="${escapeAttribute(entry.id)}" data-script-status="${escapeAttribute(entry.id)}" hidden></p>`
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
    <a class="button" href="${escapeAttribute(entry.url)}">Open dashboard</a>${restartButton}${terminateButton}
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
  const buttons = document.querySelectorAll('button[data-script-action]');
  buttons.forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.getAttribute('data-script-action');
      const id = button.getAttribute(action === 'terminate' ? 'data-terminate-id' : 'data-restart-id');
      if (!id) return;
      const status = document.querySelector(
        '[data-script-status="' + CSS.escape(id) + '"]'
      );
      button.disabled = true;
      const originalLabel = button.textContent;
      button.textContent = 'Running...';
      if (status) {
        status.hidden = false;
        status.classList.remove('ok', 'err');
        status.textContent = 'Running ' + action + ' script for ' + id + '...';
      }
      try {
        const res = await fetch(
          '/api/entries/' + encodeURIComponent(id) + '/' + action,
          { method: 'POST' }
        );
        const data = await res.json().catch(() => ({}));
        const ok = res.ok && data.status === 'ok';
        if (status) {
          status.classList.toggle('ok', ok);
          status.classList.toggle('err', !ok);
          const summary = ok
            ? labelAction(action) + ' OK · ' + (data.duration_ms || 0) + 'ms'
            : labelAction(action) + ' failed: ' + (data.error || 'exit ' + data.exit_code);
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
          status.textContent = labelAction(action) + ' request failed: ' +
            (error && error.message ? error.message : String(error));
        }
      } finally {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    });
  });
  function labelAction(action) {
    return action === 'terminate' ? 'Terminate' : 'Restart';
  }
})();
</script>`;

const CLAWSO_MAINTENANCE_CLIENT_SCRIPT = `<script>
(function () {
  async function refreshClawsoStatus() {
    const res = await fetch('/api/clawso-desktop-maintenance');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return;
    const total = document.querySelector('[data-clawso-footprint-total]');
    if (total && data.footprint && data.footprint.formattedTotal) {
      total.textContent = data.footprint.formattedTotal;
    }
    if (Array.isArray(data.footprint && data.footprint.paths)) {
      data.footprint.paths.forEach((entry) => {
        if (!entry || !entry.id) return;
        const value = document.querySelector('[data-clawso-footprint-path="' + CSS.escape(entry.id) + '"] strong');
        if (value && entry.formattedBytes) value.textContent = entry.formattedBytes;
      });
    }
    if (Array.isArray(data.modes)) {
      data.modes.forEach((mode) => {
        if (!mode || !mode.id) return;
        const artifact = document.querySelector('[data-clawso-artifact="' + CSS.escape(mode.id) + '"]');
        if (artifact) artifact.textContent = formatArtifact(mode.artifact);
        const activate = document.querySelector('[data-clawso-activate-mode="' + CSS.escape(mode.id) + '"]');
        if (activate) activate.disabled = !mode.artifact;
      });
    }
  }

  function formatArtifact(artifact) {
    if (!artifact || !artifact.path) return 'No artifact detected yet.';
    return artifact.bytes == null ? artifact.path : artifact.path + ' (' + formatBytes(artifact.bytes) + ')';
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value = value / 1024;
      unitIndex += 1;
    }
    const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
    return value.toFixed(precision) + ' ' + units[unitIndex];
  }

  document.querySelectorAll('button[data-clawso-build-mode]').forEach((button) => {
    button.addEventListener('click', async () => {
      const mode = button.getAttribute('data-clawso-build-mode');
      if (!mode) return;
      if (mode === 'online' && !window.confirm('Run the online release pipeline now? This can publish release artifacts.')) {
        return;
      }
      const status = document.querySelector('[data-clawso-status="' + CSS.escape(mode) + '"]');
      const artifact = document.querySelector('[data-clawso-artifact="' + CSS.escape(mode) + '"]');
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = 'Running...';
      if (status) {
        status.hidden = false;
        status.classList.remove('ok', 'err');
        status.textContent = 'Running ' + mode + ' build...';
      }
      try {
        const res = await fetch('/api/clawso-desktop-maintenance/build', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode, confirmOnlineRelease: mode === 'online' })
        });
        const data = await res.json().catch(() => ({}));
        const ok = res.ok && data.status === 'ok';
        if (status) {
          status.classList.toggle('ok', ok);
          status.classList.toggle('err', !ok);
          const summary = ok
            ? 'Build OK · ' + (data.duration_ms || 0) + 'ms'
            : 'Build failed: ' + (data.error || 'exit ' + data.exit_code);
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
        if (ok && artifact && data.artifact && data.artifact.path) {
          artifact.textContent = formatArtifact(data.artifact);
          const activate = document.querySelector('[data-clawso-activate-mode="' + CSS.escape(mode) + '"]');
          if (activate) activate.disabled = false;
        }
        await refreshClawsoStatus().catch(() => undefined);
      } catch (error) {
        if (status) {
          status.classList.add('err');
          status.textContent = 'Build request failed: ' + (error && error.message ? error.message : String(error));
        }
      } finally {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    });
  });

  document.querySelectorAll('button[data-clawso-activate-mode]').forEach((button) => {
    button.addEventListener('click', async () => {
      const mode = button.getAttribute('data-clawso-activate-mode');
      if (!mode) return;
      const status = document.querySelector('[data-clawso-status="' + CSS.escape(mode) + '"]');
      button.disabled = true;
      try {
        const res = await fetch('/api/clawso-desktop-maintenance/activate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode })
        });
        const data = await res.json().catch(() => ({}));
        const ok = res.ok && data.status === 'ok';
        if (status) {
          status.hidden = false;
          status.classList.toggle('ok', ok);
          status.classList.toggle('err', !ok);
          status.textContent = ok ? 'Activate OK' : 'Activate failed: ' + (data.error || 'unknown error');
        }
      } catch (error) {
        if (status) {
          status.hidden = false;
          status.classList.add('err');
          status.textContent = 'Activate request failed: ' + (error && error.message ? error.message : String(error));
        }
      } finally {
        button.disabled = false;
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
