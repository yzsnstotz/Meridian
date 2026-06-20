// Meridian Gateway — login / onboarding GUI (strictly additive).
//
// Adds a small, self-contained web UI plus three JSON endpoints on the SAME
// gateway HTTP server that serves `/v1`. Lets a non-technical user sign in to
// their Claude / ChatGPT / Gemini subscriptions (which back the `/v1` routes)
// without a terminal, and copy the OpenAI-compatible base URL.
//
// Routes added here (all wired from v1-gateway.ts):
//   GET  /                       → the GUI HTML
//   GET  /providers/status       → { claude, codex, gemini, antigravity } connection state
//   POST /providers/:id/login    → kick off (or describe) sign-in for one CLI
//
// NOTHING here touches /health or /v1/*. Detection is read-only (status
// commands + credential files); only POST /providers/:id/login spawns a CLI,
// and it does so detached so the browser flow never blocks the gateway.
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, renameSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { claudeAgentConfig } from "../../agents/claude";
import { codexAgentConfig } from "../../agents/codex";
import { geminiAgentConfig } from "../../agents/gemini";

export type ProviderId = "claude" | "codex" | "gemini" | "antigravity";

export interface ProviderState {
  /** The backing CLI binary is resolvable on PATH (installed on this machine). */
  installed: boolean;
  /** The CLI is installed AND signed in (its subscription can serve /v1). */
  connected: boolean;
  detail?: string;
  /** Safe account identity surfaced by the provider, never raw token material. */
  account?: string;
  /** Subscription/plan tier when the provider exposes it through a status API. */
  subscription?: string;
  /** Authentication method such as Claude.ai, ChatGPT, or Google OAuth. */
  auth?: string;
  /** Non-secret credential/account identifier, useful when email is absent. */
  credential?: string;
  /** Explicit reason a dimension cannot be shown for this provider. */
  limitation?: string;
}

export interface ProvidersStatus {
  claude: ProviderState;
  codex: ProviderState;
  gemini: ProviderState;
  antigravity: ProviderState;
}

export interface LoginResult {
  started?: boolean;
  manual?: boolean;
  url?: string;
  hint?: string;
  command?: string;
  jobId?: string;
  needsCode?: boolean;
}

export interface LoginCodeResult {
  ok: boolean;
  error?: string;
}

export interface InstallResult {
  installed: boolean;
  error?: string;
  command?: string;
}

export interface ProviderCliVersionState {
  installed: boolean;
  command: string;
  packageName: string;
  updateCommand: string;
  installedVersion?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  error?: string;
}

export interface ProvidersCliVersions {
  claude: ProviderCliVersionState;
  codex: ProviderCliVersionState;
  gemini: ProviderCliVersionState;
  antigravity: ProviderCliVersionState;
}

export interface LogoutResult {
  ok: boolean;
  detail?: string;
  command?: string;
  error?: string;
}

export interface ProviderAuthSummary {
  account?: string;
  subscription?: string;
  auth?: string;
  credential?: string;
  limitation?: string;
}

// ── CLI → npm-global package map ───────────────────────────────────────────────
//
// Each coding-agent CLI ships as an npm-global package. `bin` is the binary the
// gateway resolves on PATH (and matches the agent config `command`); `pkg` is
// the `@scope/name` installed via `npm install -g <pkg>`.
interface ProviderPackage {
  bin: string;
  pkg: string;
  installCommand?: string;
  npmManaged?: boolean;
}

const PROVIDER_PACKAGES: Record<ProviderId, ProviderPackage> = {
  claude: { bin: claudeAgentConfig.command, pkg: "@anthropic-ai/claude-code" },
  codex: { bin: codexAgentConfig.command, pkg: "@openai/codex" },
  gemini: { bin: geminiAgentConfig.command, pkg: "@google/gemini-cli" },
  antigravity: {
    bin: "agy",
    pkg: "Google Antigravity app",
    installCommand: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    npmManaged: false
  },
};

/** The `npm install -g <pkg>` command string for a provider (GUI fallback). */
export function installCommandFor(id: ProviderId): string {
  if (PROVIDER_PACKAGES[id].installCommand) return PROVIDER_PACKAGES[id].installCommand;
  return `npm install -g ${PROVIDER_PACKAGES[id].pkg}`;
}

// ── PATH augmentation (the openclaw spawn-PATH lesson) ─────────────────────────
//
// A freshly `npm install -g`'d CLI lands in the npm global bin dir, which is not
// necessarily on the PATH this process inherited (especially under a launcher /
// GUI / fnm shim). Resolve that dir once at startup and PREPEND it — plus a few
// common locations — so every subsequent spawn (status detection, login, /v1
// completions, and install-then-login chaining) finds both pre-existing and
// just-installed binaries. We never drop existing entries.

/** Resolve the npm global bin dir, or null if npm isn't available. */
function npmGlobalBinDir(): string | null {
  try {
    // `npm bin -g` was removed in npm v9+, so derive it from the prefix.
    const prefix = execFileSync("npm", ["prefix", "-g"], {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!prefix) return null;
    // On Windows the bin lives at the prefix root; elsewhere at <prefix>/bin.
    return process.platform === "win32" ? prefix : join(prefix, "bin");
  } catch {
    return null;
  }
}

let pathAugmented = false;
let lastAugmentedBinDir: string | null = null;

/**
 * Prepend the npm global bin dir (plus common dirs) to process.env.PATH, once.
 * Idempotent: safe to call repeatedly. Returns the npm global bin dir that was
 * prepended (or null if npm wasn't resolvable), so the caller can log/verify.
 */
export function ensureSpawnPath(): string | null {
  if (pathAugmented) return lastAugmentedBinDir;
  pathAugmented = true;
  const binDir = npmGlobalBinDir();
  lastAugmentedBinDir = binDir;
  const candidates = [
    binDir,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local", "bin"),
  ].filter((p): p is string => !!p);
  const existing = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const prepend = candidates.filter((p) => !existing.includes(p));
  if (prepend.length > 0) {
    process.env.PATH = [...prepend, ...existing].join(delimiter);
  }
  return binDir;
}

/** True when `command -v <bin>` resolves the binary on the (augmented) PATH. */
function isInstalled(bin: string): boolean {
  ensureSpawnPath();
  try {
    // `command -v` is POSIX; on Windows fall back to `where`. We run through a
    // shell so PATH lookup matches what spawn() will later do.
    if (process.platform === "win32") {
      execFileSync("where", [bin], { stdio: "ignore", timeout: 8000 });
    } else {
      execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "ignore", timeout: 8000 });
    }
    return true;
  } catch {
    return false;
  }
}

/** Run a short-lived command and resolve its exit code + captured output. */
function runProbe(command: string, args: string[], timeoutMs = 8000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let out = "";
    let child: ReturnType<typeof spawn>;
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
      resolve({ code, out });
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      // command not found / not spawnable → treat as a failed probe
      resolve({ code: null, out: "" });
      return;
    }
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    child.on("error", () => done(null));
    child.on("close", (code) => done(code));
  });
}

type ProbeRunner = typeof runProbe;

interface CliVersionDeps {
  installed?: (bin: string) => boolean;
  run?: ProbeRunner;
}

function parseVersionText(raw: string): string | undefined {
  const text = raw.trim().replace(/^"|"$/g, "");
  const match = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(text);
  return match?.[1];
}

function compareVersions(left: string, right: string): number {
  const l = left.split(/[.+-]/).slice(0, 3).map((part) => Number(part) || 0);
  const r = right.split(/[.+-]/).slice(0, 3).map((part) => Number(part) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((l[i] ?? 0) > (r[i] ?? 0)) return 1;
    if ((l[i] ?? 0) < (r[i] ?? 0)) return -1;
  }
  return 0;
}

function probeError(out: string, fallback: string): string {
  return (out.trim().split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() || fallback).slice(0, 220);
}

function normalizeAntigravityCliError(out: string, fallback: string): string {
  if (/Antigravity\.app|Contents\/Resources\/app\/bin\/antigravity|No such file or directory/i.test(out)) {
    return "Antigravity app binary is not available. Use Install CLI or Update CLI from the Antigravity provider card.";
  }
  return probeError(out, fallback);
}

export async function getProviderCliVersion(id: ProviderId, deps: CliVersionDeps = {}): Promise<ProviderCliVersionState> {
  ensureSpawnPath();
  const { bin, pkg } = PROVIDER_PACKAGES[id];
  const run = deps.run ?? runProbe;
  const installed = (deps.installed ?? isInstalled)(bin);
  const state: ProviderCliVersionState = {
    installed,
    command: bin,
    packageName: pkg,
    updateCommand: installCommandFor(id),
    updateAvailable: false
  };

  if (id === "antigravity") {
    if (!installed) return state;
    const versionResult = await run(bin, ["--version"], 12000);
    if (versionResult.code === 0) {
      state.installedVersion = parseVersionText(versionResult.out) ?? probeError(versionResult.out, "installed");
      return state;
    }
    state.installed = false;
    state.error = normalizeAntigravityCliError(versionResult.out, "Could not launch Antigravity CLI.");
    return state;
  }

  if (installed) {
    const versionResult = await run(bin, ["--version"], 12000);
    if (versionResult.code === 0) {
      state.installedVersion = parseVersionText(versionResult.out);
    } else {
      state.error = probeError(versionResult.out, "Could not read installed CLI version.");
    }
  }

  const latestResult = await run("npm", ["view", pkg, "version", "--json"], 15000);
  if (latestResult.code === 0) {
    state.latestVersion = parseVersionText(latestResult.out);
  } else if (!state.error) {
    state.error = probeError(latestResult.out, "Could not check latest npm version.");
  }

  if (state.installedVersion && state.latestVersion) {
    state.updateAvailable = compareVersions(state.installedVersion, state.latestVersion) < 0;
  }

  return state;
}

export async function getProvidersCliVersions(): Promise<ProvidersCliVersions> {
  const [claude, codex, gemini, antigravity] = await Promise.all([
    getProviderCliVersion("claude"),
    getProviderCliVersion("codex"),
    getProviderCliVersion("gemini"),
    getProviderCliVersion("antigravity")
  ]);
  return { claude, codex, gemini, antigravity };
}

// ── Per-provider detection ──────────────────────────────────────────────────

function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4) payload += "=";
    const decoded = Buffer.from(payload, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function jwtAccount(token: unknown): string | undefined {
  const payload = decodeJwtPayload(token);
  const email = payload?.email;
  if (typeof email === "string" && email.trim()) return email.trim();
  const preferredUsername = payload?.preferred_username;
  if (typeof preferredUsername === "string" && preferredUsername.trim()) return preferredUsername.trim();
  const subject = payload?.sub;
  return typeof subject === "string" && subject.trim() ? `subject ${subject.trim()}` : undefined;
}

function safeJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function objectProp(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringProp(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function summarizeCodexAuthJson(raw: string): ProviderAuthSummary {
  const parsed = safeJsonObject(raw);
  if (!parsed) {
    return { limitation: "Codex OAuth file could not be parsed." };
  }
  const tokens = objectProp(parsed, "tokens");
  const authMode = stringProp(parsed, "auth_mode");
  const accountId = stringProp(tokens, "account_id");
  return {
    account: jwtAccount(tokens?.id_token),
    auth: authMode === "chatgpt" ? "ChatGPT" : authMode,
    credential: accountId ? `account ${accountId}` : undefined,
    limitation: "Subscription tier is not exposed by Codex CLI status."
  };
}

export function summarizeGeminiAuthJson(raw: string): ProviderAuthSummary {
  const parsed = safeJsonObject(raw);
  if (!parsed) {
    return { limitation: "Gemini OAuth file could not be parsed." };
  }
  const expiry = typeof parsed.expiry_date === "number" ? parsed.expiry_date : undefined;
  const refreshToken = stringProp(parsed, "refresh_token");
  const credential = expiry && expiry > Date.now()
    ? `token valid until ${new Date(expiry).toLocaleString()}`
    : refreshToken
      ? "refresh token available"
      : undefined;
  return {
    account: jwtAccount(parsed.id_token),
    auth: "Google OAuth",
    credential,
    limitation: "Subscription tier is not exposed by Gemini CLI status."
  };
}

/**
 * claude: `claude auth status` (exit 0 + signed-in signal). Modern CLI prints
 * a JSON object ({ loggedIn, email, subscriptionType, ... }); older builds
 * print a human line. Fall back to ~/.claude/.credentials.json existing.
 */
async function detectClaude(): Promise<ProviderState> {
  const installed = isInstalled(PROVIDER_PACKAGES.claude.bin);
  if (installed) {
    const { code, out } = await runProbe(claudeAgentConfig.command, ["auth", "status"]);
    const text = out.trim();
    if (code === 0 && text) {
      try {
        const j = JSON.parse(text) as {
          loggedIn?: boolean;
          email?: string;
          subscriptionType?: string;
          authMethod?: string;
          orgName?: string;
        };
        if (j.loggedIn) {
          const plan = j.subscriptionType ? `${j.subscriptionType} plan` : undefined;
          const detail = [j.email, plan].filter(Boolean).join(" · ") || "Signed in";
          return {
            installed,
            connected: true,
            detail,
            account: j.email,
            subscription: plan,
            auth: j.authMethod,
            credential: j.orgName
          };
        }
      } catch {
        // non-JSON output: look for an affirmative signal
        if (/logged ?in|signed ?in|authenticated/i.test(text) && !/not /i.test(text)) {
          return { installed, connected: true, detail: text.split("\n")[0]?.slice(0, 80) };
        }
      }
    }
  }
  // Fallback: credentials file present means a prior successful OAuth login.
  const credPath = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(credPath)) {
    return { installed, connected: true, detail: "Signed in" };
  }
  return { installed, connected: false };
}

/** codex: `codex login status` → "Logged in ..." means connected. */
async function detectCodex(): Promise<ProviderState> {
  const installed = isInstalled(PROVIDER_PACKAGES.codex.bin);
  const authPath = join(homedir(), ".codex", "auth.json");
  const summary = existsSync(authPath) ? summarizeCodexAuthJson(readFileSync(authPath, "utf8")) : {};
  if (installed) {
    const { out } = await runProbe(codexAgentConfig.command, ["login", "status"]);
    const line = out.trim().split("\n").find((l) => l.trim().length > 0)?.trim();
    if (line && /logged in/i.test(line) && !/not logged in/i.test(line)) {
      return {
        installed,
        connected: true,
        detail: [summary.account, summary.auth || line].filter(Boolean).join(" · ") || line,
        ...summary
      };
    }
  }
  return { installed, connected: false, ...summary };
}

/**
 * gemini: no status command — read ~/.gemini/oauth_creds.json. Connected when
 * it parses AND (expiry_date is in the future OR a refresh_token is present, so
 * an expired access token that can be silently refreshed still counts).
 */
async function detectGemini(): Promise<ProviderState> {
  const installed = isInstalled(PROVIDER_PACKAGES.gemini.bin);
  const credPath = join(homedir(), ".gemini", "oauth_creds.json");
  if (!existsSync(credPath)) return { installed, connected: false };
  try {
    const raw = readFileSync(credPath, "utf8");
    const summary = summarizeGeminiAuthJson(raw);
    const creds = JSON.parse(raw) as {
      expiry_date?: number;
      refresh_token?: string;
    };
    const future = typeof creds.expiry_date === "number" && creds.expiry_date > Date.now();
    const refreshable = typeof creds.refresh_token === "string" && creds.refresh_token.length > 0;
    if (future || refreshable) {
      const detail = future
        ? [summary.account, `token valid until ${new Date(creds.expiry_date as number).toLocaleString()}`].filter(Boolean).join(" · ")
        : [summary.account, "auto-refreshing"].filter(Boolean).join(" · ");
      return {
        installed,
        connected: true,
        detail,
        ...summary
      };
    }
    return { installed, connected: false, ...summary };
  } catch {
    return { installed, connected: false };
  }
}

async function detectAntigravity(): Promise<ProviderState> {
  if (!isInstalled(PROVIDER_PACKAGES.antigravity.bin)) {
    return { installed: false, connected: false };
  }
  const version = await runProbe(PROVIDER_PACKAGES.antigravity.bin, ["--version"], 12000);
  if (version.code !== 0) {
    return {
      installed: false,
      connected: false,
      detail: normalizeAntigravityCliError(version.out, "Antigravity CLI could not be launched.")
    };
  }
  const models = await runProbe(PROVIDER_PACKAGES.antigravity.bin, ["models"], 12000);
  if (models.code === 0 && models.out.trim().length > 0) {
    return {
      installed: true,
      connected: true,
      detail: "Authorized · models available",
      auth: "Antigravity",
      limitation: "Subscription tier is not exposed by Antigravity CLI status."
    };
  }
  return {
    installed: true,
    connected: false,
    detail: probeError(models.out, "Sign in with Antigravity"),
    auth: "Antigravity",
    limitation: "Subscription tier is not exposed by Antigravity CLI status."
  };
}

export async function getProvidersStatus(): Promise<ProvidersStatus> {
  ensureSpawnPath();
  const [claude, codex, gemini, antigravity] = await Promise.all([
    detectClaude(),
    detectCodex(),
    detectGemini(),
    detectAntigravity()
  ]);
  return { claude, codex, gemini, antigravity };
}

// ── Install (one-click CLI setup) ──────────────────────────────────────────────
//
// Runs the provider's official installer so a non-technical user never needs a
// terminal. npm-global installs can be slow, and Antigravity's installer
// downloads a binary + configures PATH, so the timeout is generous. On any
// failure (e.g. EACCES on a sudo-only prefix) we return the exact command so the
// GUI can offer a copy-the-command fallback.
type InstallDeps = CliVersionDeps;

function installerInvocationFor(id: ProviderId): { command: string; args: string[] } {
  const { pkg, npmManaged } = PROVIDER_PACKAGES[id];
  if (npmManaged === false) {
    return { command: "/bin/sh", args: ["-c", installCommandFor(id)] };
  }
  return { command: "npm", args: ["install", "-g", pkg] };
}

function installError(out: string, fallback: string): string {
  const line = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /npm error|EACCES|EPERM|permission denied|not permitted|code E|failed|error/i.test(l))
    .pop();
  return (line || out.trim().split("\n").slice(-1)[0] || fallback).slice(0, 240);
}

export async function installProvider(id: ProviderId, timeoutMs = 300000, deps: InstallDeps = {}): Promise<InstallResult> {
  const { bin } = PROVIDER_PACKAGES[id];
  const command = installCommandFor(id);
  const run = deps.run ?? runProbe;
  const installed = deps.installed ?? isInstalled;
  const installer = installerInvocationFor(id);
  ensureSpawnPath();
  const result = await run(installer.command, installer.args, timeoutMs);
  if (result.code === 0) {
    // Re-confirm the binary is now resolvable on the augmented PATH.
    if (installed(bin)) return { installed: true };
    return {
      installed: false,
      error: installError(result.out, "Installed, but the CLI was not found on PATH"),
      command
    };
  }
  if (result.code === null) {
    return {
      installed: false,
      error: installError(result.out, "Install timed out or the installer could not be launched"),
      command
    };
  }
  return {
    installed: false,
    error: installError(result.out, `Installer exited with code ${result.code}`),
    command
  };
}

export async function updateProviderCli(id: ProviderId, timeoutMs = 300000, deps: InstallDeps = {}): Promise<InstallResult & { version?: ProviderCliVersionState }> {
  const result = await installProvider(id, timeoutMs, deps);
  if (!result.installed) return result;
  return {
    ...result,
    version: await getProviderCliVersion(id, deps)
  };
}

// ── Logout / account switch ──────────────────────────────────────────────────

interface LogoutDeps {
  homeDir?: string;
  now?: () => Date;
  run?: ProbeRunner;
}

const PROVIDER_LOGOUT_COMMANDS: Record<ProviderId, string[][]> = {
  claude: [["auth", "logout"]],
  codex: [["logout"], ["login", "logout"]],
  gemini: [],
  antigravity: [["logout"], ["auth", "logout"]],
};

function credentialFilesFor(id: ProviderId, homeDir: string): string[] {
  if (id === "claude") {
    return [
      join(homeDir, ".claude", ".credentials.json"),
      join(homeDir, ".claude", "credentials.json"),
    ];
  }
  if (id === "codex") return [join(homeDir, ".codex", "auth.json")];
  if (id === "gemini") return [join(homeDir, ".gemini", "oauth_creds.json")];
  return [
    join(homeDir, ".antigravity", "auth.json"),
    join(homeDir, ".antigravity", "oauth_creds.json"),
    join(homeDir, ".config", "antigravity", "auth.json"),
    join(homeDir, ".config", "antigravity", "credentials.json"),
  ];
}

function displayLocalPath(filePath: string, homeDir: string): string {
  const homeWithSlash = homeDir.endsWith("/") ? homeDir : homeDir + "/";
  return filePath.startsWith(homeWithSlash) ? "~/" + filePath.slice(homeWithSlash.length) : filePath;
}

function backupCredentialFile(filePath: string, homeDir: string, now: Date): LogoutResult | null {
  if (!existsSync(filePath)) return null;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let backupPath = `${filePath}.logged-out-${stamp}`;
  let suffix = 2;
  while (existsSync(backupPath)) {
    backupPath = `${filePath}.logged-out-${stamp}-${suffix}`;
    suffix += 1;
  }
  try {
    renameSync(filePath, backupPath);
    return {
      ok: true,
      detail: `Signed out. Previous credential file backed up as ${displayLocalPath(backupPath, homeDir)}.`,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Could not move credential file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function commandText(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

export async function logoutProvider(id: ProviderId, deps: LogoutDeps = {}): Promise<LogoutResult> {
  ensureSpawnPath();
  const run = deps.run ?? runProbe;
  const homeDir = deps.homeDir ?? homedir();
  const now = deps.now ?? (() => new Date());
  const command = PROVIDER_PACKAGES[id].bin;

  for (const args of PROVIDER_LOGOUT_COMMANDS[id]) {
    const result = await run(command, args, 12000);
    if (result.code === 0) {
      return {
        ok: true,
        detail: `Signed out with ${LABELS_FOR_RESULT[id]} CLI.`,
        command: commandText(command, args),
      };
    }
  }

  for (const filePath of credentialFilesFor(id, homeDir)) {
    const result = backupCredentialFile(filePath, homeDir, now());
    if (result) return result;
  }

  return {
    ok: true,
    detail: "No local session file was found. You can connect again to choose an account.",
  };
}

const LABELS_FOR_RESULT: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  antigravity: "Antigravity",
};

// ── Login kick-off ───────────────────────────────────────────────────────────

const URL_RE = /(https?:\/\/[^\s'"]+)/;
const ANTIGRAVITY_CODE_LOGIN_HINT =
  "Opened Antigravity sign-in without Terminal. Complete Google OAuth in the browser, paste the authorization code here, and this page updates automatically once agy models works.";
const ANTIGRAVITY_MANUAL_LOGIN_HINT =
  "Could not start Antigravity sign-in automatically. Copy this command into Terminal, then complete the Antigravity sign-in prompts. This page updates automatically once agy models works.";
const ANTIGRAVITY_LOGIN_PROMPT = "Reply with exactly OK.";
const ANTIGRAVITY_LOGIN_JOB_TTL_MS = 5 * 60_000;

interface AntigravityLoginJob {
  child: ReturnType<typeof spawn>;
  createdAt: number;
}

const antigravityLoginJobs = new Map<string, AntigravityLoginJob>();

function cleanupAntigravityLoginJobs(): void {
  const cutoff = Date.now() - ANTIGRAVITY_LOGIN_JOB_TTL_MS;
  for (const [jobId, job] of antigravityLoginJobs) {
    if (job.createdAt >= cutoff) continue;
    try {
      job.child.kill();
    } catch {
      // best-effort cleanup
    }
    antigravityLoginJobs.delete(jobId);
  }
}

interface LoginDeps {
  platform?: NodeJS.Platform;
  run?: ProbeRunner;
  spawnLogin?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ReturnType<typeof spawn>;
}

/**
 * Spawn an interactive sign-in CLI detached so it survives this request and
 * opens the user's browser. Listen ~3s for any printed auth URL, then detach.
 */
function startBrowserLogin(command: string, args: string[]): Promise<LoginResult> {
  return new Promise((resolve) => {
    let url: string | undefined;
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      try {
        child.unref();
      } catch {
        // ignore
      }
      resolve({ started: true, url });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch {
      resolve({ started: false });
      return;
    }
    const scan = (chunk: Buffer): void => {
      const m = URL_RE.exec(chunk.toString());
      if (m && !url) {
        url = m[1];
        // Got the URL — return promptly so the GUI can show / open it.
        finish();
      }
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("error", () => finish());
    // Detach after a short capture window even if no URL was printed (the CLI
    // may open the browser itself without echoing the URL).
    setTimeout(finish, 3000);
  });
}

// ── gemini login (the special case) ─────────────────────────────────────────
//
// gemini-cli has no `auth`/`login` subcommand. Its only OAuth path is the
// first-run "Login with Google" flow, which behaves like this:
//
//   1. If ~/.gemini/settings.json has NO `security.auth.selectedType`, an
//      INTERACTIVE launch shows a TUI menu asking you to pick an auth method.
//      A non-TTY/headless spawn can't drive that menu. Pre-seeding the auth
//      method to "oauth-personal" makes gemini SKIP the menu and go straight
//      to the Google OAuth flow.
//   2. With the auth method set, `gemini -p "<prompt>"` (headless) and no
//      `NO_BROWSER` env reaches the browser-launch branch: it prints
//      "Opening authentication page in your browser. Do you want to continue?
//      [Y/n]:" on stdout, waits for a `y`, then starts a localhost OAuth
//      callback server and calls the platform "open" to launch the Google
//      consent page in the default browser. Completing it in the browser
//      writes ~/.gemini/oauth_creds.json — which detectGemini() already reads.
//   3. If NO_BROWSER is set OR the session is judged non-interactive *and*
//      browser launch is suppressed, it instead throws a fatal "manual
//      authorization required" error. So we must NOT set NO_BROWSER and must
//      feed `y\n` on stdin to clear the consent prompt.
//
// We feed `y\n` on stdin to auto-accept the consent prompt, scan stdout/stderr
// for the printed auth URL (so the GUI can offer a fallback link), and detach
// so the OAuth callback server + browser flow outlive this request. The GUI's
// existing status poll flips the card to Connected once oauth_creds.json lands.

const GEMINI_AUTH_OAUTH_PERSONAL = "oauth-personal";

/**
 * Ensure ~/.gemini/settings.json declares an auth method so gemini skips its
 * interactive auth-method menu. STRICTLY non-destructive:
 *   • reads any existing settings.json,
 *   • returns early WITHOUT writing if security.auth.selectedType is already
 *     set (we never change an existing user choice),
 *   • backs the file up to settings.json.mgw-bak before writing,
 *   • only ADDS the missing nested key, preserving every other field.
 * Returns true if a usable auth method is present (pre-existing or just added),
 * false only if we couldn't establish one (in which case login falls back to a
 * manual hint). Never throws.
 */
export function ensureGeminiAuthMethod(): boolean {
  try {
    const dir = join(homedir(), ".gemini");
    const settingsPath = join(dir, "settings.json");
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
        if (parsed && typeof parsed === "object") settings = parsed as Record<string, unknown>;
      } catch {
        // Corrupt/unparseable settings.json: do NOT overwrite the user's file.
        return false;
      }
    }
    const security = (settings.security ?? {}) as Record<string, unknown>;
    const auth = (security.auth ?? {}) as Record<string, unknown>;
    // Already chosen? Leave it exactly as-is (additive-only contract).
    if (typeof auth.selectedType === "string" && auth.selectedType.length > 0) {
      return true;
    }
    // Add only the missing key, preserving sibling fields.
    auth.selectedType = GEMINI_AUTH_OAUTH_PERSONAL;
    security.auth = auth;
    settings.security = security;
    mkdirSync(dir, { recursive: true });
    // Back up an existing file before our additive write.
    if (existsSync(settingsPath)) {
      try {
        copyFileSync(settingsPath, settingsPath + ".mgw-bak");
      } catch {
        // Backup is best-effort; the write itself is still purely additive.
      }
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Kick off gemini's first-run Google OAuth from the GUI. Pre-seeds the auth
 * method (non-destructively), then spawns a detached headless `gemini -p`
 * which opens the Google consent page in the browser. We auto-answer the
 * consent prompt with `y`, scan briefly for the printed auth URL, then detach.
 */
function startGeminiLogin(): Promise<LoginResult> {
  if (!ensureGeminiAuthMethod()) {
    // Couldn't establish an auth method (e.g. unreadable settings.json) → guide.
    return Promise.resolve({
      manual: true,
      hint: `Open a terminal and run \`${geminiAgentConfig.command}\`, then choose ‘Login with Google’. This page updates automatically once you’re signed in.`,
    });
  }
  return new Promise((resolve) => {
    let url: string | undefined;
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      try {
        child.unref();
      } catch {
        // ignore
      }
      resolve({ started: true, url });
    };
    let child: ReturnType<typeof spawn>;
    try {
      // Headless prompt so gemini authenticates immediately; piped stdio so we
      // can answer the consent prompt and scan for the auth URL. Detached so
      // the OAuth callback server + browser flow survive this request. We do
      // NOT set NO_BROWSER, so gemini opens the browser itself.
      child = spawn(geminiAgentConfig.command, ["-p", "hello"], {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch {
      resolve({
        manual: true,
        hint: `Open a terminal and run \`${geminiAgentConfig.command}\`, then choose ‘Login with Google’. This page updates automatically once you’re signed in.`,
      });
      return;
    }
    // Auto-accept the "Opening authentication page… continue? [Y/n]" prompt.
    try {
      child.stdin?.write("y\n");
      child.stdin?.end();
    } catch {
      // ignore — if stdin isn't writable the consent default ([Y]) still helps
    }
    const scan = (chunk: Buffer): void => {
      const m = URL_RE.exec(chunk.toString());
      if (m && !url) {
        url = m[1];
        finish();
      }
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("error", () => finish());
    // Detach after a short capture window even if no URL was echoed (gemini may
    // open the browser without printing a copyable URL).
    setTimeout(finish, 3000);
  });
}

async function startAntigravityLogin(deps: LoginDeps = {}): Promise<LoginResult> {
  const command = PROVIDER_PACKAGES.antigravity.bin;
  const spawnLogin = deps.spawnLogin ?? spawn;
  cleanupAntigravityLoginJobs();
  let child: ReturnType<typeof spawn>;
  try {
    child = spawnLogin(command, ["--print", ANTIGRAVITY_LOGIN_PROMPT], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: false
    });
  } catch {
    return {
      manual: true,
      hint: ANTIGRAVITY_MANUAL_LOGIN_HINT,
      command,
    };
  }

  const jobId = randomUUID();
  antigravityLoginJobs.set(jobId, { child, createdAt: Date.now() });
  const ttlTimer = setTimeout(() => {
    const job = antigravityLoginJobs.get(jobId);
    if (!job) return;
    try {
      job.child.kill();
    } catch {
      // best-effort cleanup
    }
    antigravityLoginJobs.delete(jobId);
  }, ANTIGRAVITY_LOGIN_JOB_TTL_MS);
  ttlTimer.unref?.();

  return new Promise((resolve) => {
    let url: string | undefined;
    let resolved = false;
    const finish = (result?: Partial<LoginResult>): void => {
      if (resolved) return;
      resolved = true;
      resolve({
        started: true,
        hint: ANTIGRAVITY_CODE_LOGIN_HINT,
        command,
        jobId,
        needsCode: true,
        url,
        ...result
      });
    };
    const scan = (chunk: Buffer): void => {
      const m = URL_RE.exec(chunk.toString());
      if (m && !url) {
        url = m[1];
        finish();
      }
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("error", () => {
      antigravityLoginJobs.delete(jobId);
      finish({ started: undefined, manual: true, needsCode: undefined, jobId: undefined, hint: ANTIGRAVITY_MANUAL_LOGIN_HINT });
    });
    child.on("close", () => {
      setTimeout(() => antigravityLoginJobs.delete(jobId), 30_000).unref?.();
      if (!resolved) finish({ needsCode: false });
    });
    setTimeout(() => finish(), 3000).unref?.();
  });
}

export function submitAntigravityLoginCode(jobId: string, code: string): LoginCodeResult {
  cleanupAntigravityLoginJobs();
  const safeJobId = jobId.trim();
  const safeCode = code.trim();
  if (!safeJobId || !safeCode) {
    return { ok: false, error: "missing authorization code" };
  }
  const job = antigravityLoginJobs.get(safeJobId);
  if (!job || !job.child.stdin || job.child.stdin.destroyed) {
    return { ok: false, error: "login session expired" };
  }
  try {
    job.child.stdin.write(`${safeCode}\n`);
    antigravityLoginJobs.delete(safeJobId);
    return { ok: true };
  } catch {
    return { ok: false, error: "could not submit authorization code" };
  }
}

export async function startLogin(id: ProviderId, deps: LoginDeps = {}): Promise<LoginResult> {
  if (id === "claude") {
    return startBrowserLogin(claudeAgentConfig.command, ["auth", "login"]);
  }
  if (id === "codex") {
    return startBrowserLogin(codexAgentConfig.command, ["login"]);
  }
  if (id === "antigravity") {
    return startAntigravityLogin(deps);
  }
  // gemini: no `login` subcommand — drive its first-run Google OAuth instead.
  return startGeminiLogin();
}

// ── GUI ───────────────────────────────────────────────────────────────────────

/**
 * The single self-contained onboarding page. All CSS + JS is inlined so it
 * works offline inside an iframe with no external/CDN dependencies. `port` is
 * the actual bound port so the displayed endpoint is correct.
 *
 * Wording is provider-neutral: this is described only as a local
 * OpenAI-compatible endpoint, usable by any client.
 */
export function renderLoginPage(port: number): string {
  const endpoint = `http://127.0.0.1:${port}/v1`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>Meridian Gateway</title>
<style>
  :root {
    --bg: #f6f7f9;
    --panel: #ffffff;
    --panel-2: #fbfcfd;
    --border: #e6e8ec;
    --border-strong: #d6d9df;
    --text: #1d2127;
    --muted: #646b76;
    --faint: #8a909a;
    --accent: #4f46e5;
    --ok: #1aa260;
    --ok-bg: rgba(26,162,96,.12);
    --off: #aab0bb;
    --shadow: 0 1px 2px rgba(16,18,22,.04), 0 8px 24px rgba(16,18,22,.06);
    --shadow-sm: 0 1px 2px rgba(16,18,22,.05);
    --radius: 16px;
    --radius-sm: 11px;
    --claude: #d97757;
    --codex: #10a37f;
    --gemini: #4285f4;
    --antigravity: #f59e0b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115;
      --panel: #181b21;
      --panel-2: #1d2128;
      --border: #272b33;
      --border-strong: #333944;
      --text: #e8eaed;
      --muted: #9aa1ac;
      --faint: #6b7280;
      --accent: #8b8bff;
      --ok: #36d399;
      --ok-bg: rgba(54,211,153,.14);
      --off: #4a515c;
      --shadow: 0 1px 2px rgba(0,0,0,.3), 0 12px 32px rgba(0,0,0,.4);
      --shadow-sm: 0 1px 2px rgba(0,0,0,.3);
      --claude: #e08a6b;
      --codex: #2bbf99;
      --gemini: #5b9bff;
      --antigravity: #fbbf24;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    padding: 28px clamp(20px, 4vw, 44px) 56px;
  }
  .wrap { width: 100%; max-width: 1040px; min-width: 0; margin: 0 auto; }

  header.top {
    display: flex; align-items: center; gap: 12px;
    margin: 4px 2px 26px;
  }
  .logo {
    width: 38px; height: 38px; border-radius: 11px; flex: none;
    background: linear-gradient(135deg, var(--accent), #8b5cf6);
    display: grid; place-items: center;
    box-shadow: var(--shadow-sm);
  }
  .logo svg { width: 21px; height: 21px; }
  .title h1 { font-size: 19px; font-weight: 680; margin: 0; letter-spacing: -.01em; }
  .title p { margin: 1px 0 0; font-size: 12.5px; color: var(--faint); }
  .top-actions {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    flex-wrap: wrap;
  }
  .language-control {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--faint);
    font-size: 12px;
    font-weight: 650;
  }
  .language-control select {
    appearance: none;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    background: var(--panel-2);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    font-weight: 650;
    min-height: 31px;
    padding: 0 28px 0 11px;
    cursor: pointer;
    background-image:
      linear-gradient(45deg, transparent 50%, var(--muted) 50%),
      linear-gradient(135deg, var(--muted) 50%, transparent 50%);
    background-position:
      calc(100% - 14px) 13px,
      calc(100% - 9px) 13px;
    background-size: 5px 5px, 5px 5px;
    background-repeat: no-repeat;
  }
  .pill {
    display: inline-flex; align-items: center; gap: 7px;
    font-size: 12px; font-weight: 600; color: var(--ok);
    background: var(--ok-bg); border-radius: 999px; padding: 6px 12px 6px 10px;
    white-space: nowrap;
  }
  .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); position: relative; }
  .pill .dot::after {
    content: ""; position: absolute; inset: -4px; border-radius: 50%;
    background: var(--ok); opacity: .35; animation: ping 1.8s ease-out infinite;
  }
  @keyframes ping { 0% { transform: scale(.6); opacity: .5; } 100% { transform: scale(2.2); opacity: 0; } }

  .tabs {
    display: inline-flex;
    gap: 4px;
    margin: -8px 2px 24px;
    padding: 4px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-sm);
  }
  .tab-btn {
    appearance: none;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    font-weight: 650;
    padding: 7px 14px;
  }
  .tab-btn.active {
    background: var(--accent);
    color: #fff;
  }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  section { margin-bottom: 22px; }
  .sec-head { margin: 0 2px 11px; }
  .sec-head.row {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 12px;
  }
  .sec-head h2 { font-size: 13px; font-weight: 640; letter-spacing: .02em; text-transform: uppercase; color: var(--muted); margin: 0; }
  .sec-head p { margin: 4px 0 0; font-size: 13px; color: var(--faint); }
  .sec-head .meta { margin-top: 3px; font-size: 12px; color: var(--faint); }

  .cards {
    display: grid; gap: 14px;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    align-items: stretch;
  }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: var(--shadow); padding: 18px;
    display: grid;
    grid-template-columns: auto 1fr;
    grid-template-rows: auto minmax(88px, 1fr) auto;
    grid-template-areas: "ico head" "body body" "actions actions";
    align-items: start; column-gap: 14px; row-gap: 12px;
    min-height: 294px;
    min-width: 0;
    transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease;
  }
  .card:hover { border-color: var(--border-strong); }
  .card.connected { border-color: color-mix(in srgb, var(--ok) 30%, var(--border)); }
  .card .ico {
    grid-area: ico;
    width: 42px; height: 42px; border-radius: 12px; flex: none;
    display: grid; place-items: center; font-weight: 700; font-size: 16px; color: #fff;
  }
  .ico.claude { background: var(--claude); }
  .ico.codex  { background: var(--codex); }
  .ico.gemini { background: var(--gemini); }
  .ico.antigravity { background: var(--antigravity); }
  .card .head { grid-area: head; min-width: 0; align-self: center; }
  .card .body { grid-area: body; min-width: 0; align-self: stretch; }
  .card .name { font-weight: 640; font-size: 15.5px; }
  .card .stat { display: inline-flex; align-items: center; gap: 7px; margin-top: 3px; font-size: 13px; color: var(--muted); }
  .card .stat .sdot { width: 9px; height: 9px; border-radius: 50%; background: var(--off); flex: none; }
  .card.connected .stat .sdot { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }
  .card .detail {
    margin-top: 2px; font-size: 12.5px; color: var(--faint);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
  }
  .card .facts {
    display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px;
  }
  .card .fact {
    max-width: 100%;
    min-width: 0;
    border: 1px solid var(--border);
    background: var(--panel-2);
    color: var(--muted);
    border-radius: 999px;
    padding: 3px 8px;
    font-size: 11.5px;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card .fact.warn { color: #b7791f; border-color: rgba(183,121,31,.35); }
  .card .actions { grid-area: actions; display: flex; gap: 8px; align-items: stretch; align-self: end; flex-wrap: wrap; }
  .card .actions button.btn, .card .actions .badge-ok { width: 100%; justify-content: center; }
  .card.connected .actions .badge-ok {
    flex: 1 1 auto;
    min-width: 0;
    border-radius: 10px;
  }

  button.btn {
    appearance: none; border: 0; cursor: pointer; font: inherit; font-weight: 600;
    border-radius: 10px; padding: 9px 16px; color: #fff; background: var(--accent);
    transition: filter .12s ease, transform .04s ease;
  }
  button.btn:hover { filter: brightness(1.06); }
  button.btn:active { transform: translateY(1px); }
  button.btn:disabled { opacity: .55; cursor: default; filter: none; transform: none; }
  .card.claude  button.btn { background: var(--claude); }
  .card.codex   button.btn { background: var(--codex); }
  .card.gemini  button.btn { background: var(--gemini); }
  .card.antigravity button.btn { background: var(--antigravity); }
  button.logout-btn,
  button.update-btn {
    appearance: none; flex: 1 1 92px; min-width: 92px; cursor: pointer; font: inherit; font-weight: 600;
    border-radius: 10px; padding: 8px 13px; color: var(--muted); background: var(--panel-2);
    border: 1px solid var(--border-strong);
    transition: background .12s ease, border-color .12s ease, color .12s ease, transform .04s ease;
  }
  button.update-btn { color: var(--accent); }
  button.logout-btn:hover,
  button.update-btn:hover { border-color: var(--accent); color: var(--accent); }
  button.logout-btn:active,
  button.update-btn:active { transform: translateY(1px); }
  button.logout-btn:disabled,
  button.update-btn:disabled { opacity: .55; cursor: default; transform: none; }
  .badge-ok {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 13px; font-weight: 600; color: var(--ok);
    background: var(--ok-bg); border-radius: 999px; padding: 6px 12px;
  }
  .badge-ok svg { width: 14px; height: 14px; }

  .hintbox {
    margin-top: 11px; font-size: 13px; line-height: 1.5; color: var(--muted);
    background: var(--panel-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 10px 13px; display: none;
  }
  .hintbox.show { display: block; }
  .hintbox code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    font-size: 12.5px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; padding: 1px 6px;
  }
  .hintbox .cmd-row {
    display: flex; gap: 8px; align-items: stretch; margin-top: 9px;
  }
  .hintbox .auth-code-row {
    display: flex; gap: 8px; align-items: stretch; margin-top: 9px; flex-wrap: wrap;
  }
  .hintbox .auth-code-row input {
    flex: 1 1 220px; min-width: 0;
    border: 1px solid var(--border-strong); border-radius: 10px; background: var(--bg);
    color: var(--text); font: inherit; font-size: 12.5px; padding: 8px 10px;
  }
  .hintbox .auth-code-row button {
    appearance: none; border: 1px solid var(--border-strong); border-radius: 10px;
    background: var(--panel); color: var(--text); cursor: pointer; font: inherit;
    font-size: 12.5px; font-weight: 650; padding: 8px 12px;
  }
  .hintbox .auth-code-row button:hover { border-color: var(--accent); color: var(--accent); }
  .hintbox .cmd {
    flex: 1 1 auto; min-width: 0;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    font-size: 12px; background: var(--bg); border: 1px solid var(--border-strong);
    border-radius: 8px; padding: 7px 10px; color: var(--text);
    overflow-x: auto; white-space: nowrap;
  }
  .hintbox button.cmd-copy {
    appearance: none; flex: none; cursor: pointer; font: inherit; font-weight: 600; font-size: 12px;
    border: 1px solid var(--border-strong); background: var(--panel-2); color: var(--text);
    border-radius: 8px; padding: 0 12px;
    display: inline-flex; align-items: center; gap: 5px;
    transition: background .12s ease, border-color .12s ease, color .12s ease;
  }
  .hintbox button.cmd-copy:hover { border-color: var(--accent); color: var(--accent); }
  .hintbox button.cmd-copy.done { background: var(--ok-bg); border-color: var(--ok); color: var(--ok); }
  .hintbox button.cmd-copy svg { width: 13px; height: 13px; }
  .hintbox .err { color: var(--text); }
  .hintbox .spin {
    display: inline-block; width: 12px; height: 12px; margin-right: 7px; vertical-align: -1px;
    border: 2px solid var(--border-strong); border-top-color: var(--accent);
    border-radius: 50%; animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .endpoint-card {
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: var(--shadow); padding: 18px;
  }
  .field-label {
    font-size: 11.5px; font-weight: 640; letter-spacing: .03em; text-transform: uppercase;
    color: var(--faint); margin: 0 2px 7px;
  }
  .endpoint-row { display: flex; gap: 10px; align-items: stretch; flex-wrap: wrap; }
  button.copy.rotate { min-width: 96px; }
  button.copy.rotate:hover { border-color: var(--accent); color: var(--accent); }
  .endpoint-url {
    flex: 1 1 auto; min-width: 0; display: flex; align-items: center;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 14px;
    background: var(--panel-2); border: 1px solid var(--border-strong); border-radius: 10px;
    padding: 0 14px; color: var(--text); overflow-x: auto; white-space: nowrap;
  }
  button.copy {
    appearance: none; border: 1px solid var(--border-strong); background: var(--panel-2);
    color: var(--text); font: inherit; font-weight: 600; cursor: pointer;
    border-radius: 10px; padding: 10px 16px; flex: none; min-width: 92px;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    transition: background .12s ease, border-color .12s ease, color .12s ease;
  }
  button.copy:hover { border-color: var(--accent); color: var(--accent); }
  button.copy.done { background: var(--ok-bg); border-color: var(--ok); color: var(--ok); }
  button.copy svg { width: 15px; height: 15px; }
  .model-refresh-controls {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
  .model-refresh-controls select {
    appearance: none;
    min-height: 34px;
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    background: var(--panel-2);
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
    font-weight: 650;
    padding: 0 29px 0 10px;
    cursor: pointer;
    background-image:
      linear-gradient(45deg, transparent 50%, var(--muted) 50%),
      linear-gradient(135deg, var(--muted) 50%, transparent 50%);
    background-position:
      calc(100% - 14px) 14px,
      calc(100% - 9px) 14px;
    background-size: 5px 5px, 5px 5px;
    background-repeat: no-repeat;
  }
  button.refresh-models {
    appearance: none;
    border: 1px solid var(--border-strong);
    background: var(--panel-2);
    color: var(--text);
    font: inherit;
    font-weight: 650;
    font-size: 12.5px;
    border-radius: 10px;
    padding: 8px 13px;
    cursor: pointer;
    white-space: nowrap;
    transition: background .12s ease, border-color .12s ease, color .12s ease, transform .04s ease;
  }
  button.refresh-models:hover { border-color: var(--accent); color: var(--accent); }
  button.refresh-models:active { transform: translateY(1px); }
  button.refresh-models:disabled { opacity: .55; cursor: default; transform: none; }
  .endpoint-note { margin: 13px 2px 0; font-size: 13px; color: var(--muted); line-height: 1.55; }
  .endpoint-note + .endpoint-note { margin-top: 7px; color: var(--faint); }
  .endpoint-note code, .endpoint-note kbd {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 12px;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px;
  }

  .test-card {
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: var(--shadow); padding: 18px;
  }
  .test-grid {
    display: grid;
    grid-template-columns: minmax(130px, .55fr) minmax(180px, 1fr) minmax(220px, 2fr) auto;
    gap: 10px;
    align-items: stretch;
  }
  .test-grid select,
  .test-grid input {
    width: 100%;
    min-height: 42px;
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    background: var(--panel-2);
    color: var(--text);
    font: inherit;
    padding: 0 12px;
  }
  .test-grid button {
    min-height: 42px;
    white-space: nowrap;
  }
  .test-result {
    display: none;
    margin-top: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--panel-2);
    padding: 12px 13px;
    color: var(--text);
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .test-result.show { display: block; }
  .test-result.error { border-color: rgba(220,38,38,.35); color: #dc2626; }
  .test-result .meta {
    display: block;
    color: var(--faint);
    font-size: 11.5px;
    margin-bottom: 5px;
    text-transform: uppercase;
    letter-spacing: .03em;
  }

  .models {
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: var(--shadow); overflow: hidden;
  }
  .model-row {
    display: flex; align-items: center; gap: 12px; padding: 12px 16px;
    border-top: 1px solid var(--border);
  }
  .model-row:first-child { border-top: 0; }
  .model-row .mid {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 13.5px;
    font-weight: 600; color: var(--text);
  }
  .model-row .by {
    margin-left: auto; font-size: 11.5px; font-weight: 600; letter-spacing: .02em;
    text-transform: uppercase; color: var(--muted);
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px;
  }
  .by.claude { color: var(--claude); border-color: color-mix(in srgb, var(--claude) 35%, var(--border)); }
  .by.codex  { color: var(--codex);  border-color: color-mix(in srgb, var(--codex) 35%, var(--border)); }
  .by.gemini { color: var(--gemini); border-color: color-mix(in srgb, var(--gemini) 35%, var(--border)); }
  .by.antigravity { color: var(--antigravity); border-color: color-mix(in srgb, var(--antigravity) 35%, var(--border)); }
  .empty { padding: 18px 16px; color: var(--faint); font-size: 13.5px; }
  .model-errors {
    border-top: 1px solid var(--border);
    padding: 12px 16px;
    color: var(--faint);
    font-size: 12.5px;
    line-height: 1.5;
  }
  .model-errors b { color: var(--muted); }
  .usage-card {
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: var(--shadow); overflow: hidden;
  }
  .usage-table-wrap { width: 100%; overflow-x: auto; }
  table.usage-table {
    width: 100%;
    border-collapse: collapse;
    min-width: 680px;
  }
  .usage-table th,
  .usage-table td {
    padding: 11px 14px;
    border-top: 1px solid var(--border);
    text-align: left;
    vertical-align: middle;
    white-space: nowrap;
  }
  .usage-table tr:first-child th { border-top: 0; }
  .usage-table th {
    color: var(--faint);
    font-size: 11.5px;
    font-weight: 700;
    letter-spacing: .03em;
    text-transform: uppercase;
  }
  .usage-table td {
    color: var(--text);
    font-size: 13px;
  }
  .usage-table .number { text-align: right; font-variant-numeric: tabular-nums; }
  .usage-table .model {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    font-weight: 650;
  }
  .usage-provider {
    display: inline-flex; align-items: center; gap: 7px;
    font-weight: 650;
  }
  .usage-provider::before {
    content: "";
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--muted);
  }
  .usage-provider.claude::before { background: var(--claude); }
  .usage-provider.codex::before { background: var(--codex); }
  .usage-provider.gemini::before { background: var(--gemini); }
  .usage-provider.antigravity::before { background: var(--antigravity); }
  .usage-empty { padding: 18px 16px; color: var(--faint); font-size: 13.5px; }
  footer { margin: 30px 2px 0; text-align: center; font-size: 12px; color: var(--faint); }
  @media (max-width: 760px) {
    .test-grid { grid-template-columns: 1fr; }
    .test-grid button { width: 100%; }
    .tabs { display: flex; width: 100%; max-width: 100%; }
    .tab-btn { flex: 1 1 0; }
  }
  @media (max-width: 640px) {
    body { overflow-x: hidden; }
    .wrap { max-width: 100%; overflow-x: hidden; }
    header.top { align-items: flex-start; flex-wrap: wrap; }
    .top-actions { width: 100%; justify-content: flex-start; margin-left: 50px; }
    .cards { grid-template-columns: minmax(0, 1fr); }
    .card .actions { flex-direction: column; }
    button.logout-btn,
    button.update-btn { width: 100%; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <header class="top">
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2v20M2 12h20M4.9 4.9l14.2 14.2M19.1 4.9 4.9 19.1" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".95"/>
          <circle cx="12" cy="12" r="3.4" fill="#fff"/>
        </svg>
      </div>
      <div class="title">
        <h1>Meridian Gateway</h1>
        <p data-i18n="subtitle">Local OpenAI- &amp; Anthropic-compatible endpoint</p>
      </div>
      <div class="top-actions">
        <label class="language-control" for="languageSelect">
          <span data-i18n="languageLabel">Language</span>
          <select id="languageSelect" data-i18n-aria="languageLabel" aria-label="Language">
            <option value="en">English</option>
            <option value="zh-CN">中文</option>
            <option value="ja">日本語</option>
          </select>
        </label>
        <span class="pill" id="runPill"><span class="dot"></span><span data-i18n="running">Running</span></span>
      </div>
    </header>

    <nav class="tabs" aria-label="Gateway pages" data-i18n-aria="gatewayPages">
      <button class="tab-btn active" type="button" data-tab="setup" data-i18n="tabSetup">Setup</button>
      <button class="tab-btn" type="button" data-tab="usage" data-i18n="tabUsage">Usage</button>
    </nav>

    <div class="tab-panel active" id="setupPanel">
    <section>
      <div class="sec-head">
        <h2 data-i18n="connectTitle">Connect your AI subscriptions</h2>
        <p data-i18n="connectCopy">Sign in to the subscriptions you already pay for. Each model below uses its matching account — no API keys needed.</p>
      </div>
      <div class="cards" id="cards">
        <div class="card claude" data-id="claude">
          <div class="ico claude">C</div>
          <div class="head">
            <div class="name">Claude</div>
            <div class="stat"><span class="sdot"></span><span class="stat-text" data-i18n="checking">Checking…</span></div>
          </div>
          <div class="body">
            <div class="detail"></div>
            <div class="facts"></div>
            <div class="hintbox"></div>
          </div>
          <div class="actions"></div>
        </div>
        <div class="card codex" data-id="codex">
          <div class="ico codex">O</div>
          <div class="head">
            <div class="name">ChatGPT <span style="color:var(--faint);font-weight:500;font-size:13px">(Codex)</span></div>
            <div class="stat"><span class="sdot"></span><span class="stat-text" data-i18n="checking">Checking…</span></div>
          </div>
          <div class="body">
            <div class="detail"></div>
            <div class="facts"></div>
            <div class="hintbox"></div>
          </div>
          <div class="actions"></div>
        </div>
        <div class="card gemini" data-id="gemini">
          <div class="ico gemini">G</div>
          <div class="head">
            <div class="name">Gemini</div>
            <div class="stat"><span class="sdot"></span><span class="stat-text" data-i18n="checking">Checking…</span></div>
          </div>
          <div class="body">
            <div class="detail"></div>
            <div class="facts"></div>
            <div class="hintbox"></div>
          </div>
          <div class="actions"></div>
        </div>
        <div class="card antigravity" data-id="antigravity">
          <div class="ico antigravity">A</div>
          <div class="head">
            <div class="name">Antigravity</div>
            <div class="stat"><span class="sdot"></span><span class="stat-text" data-i18n="checking">Checking…</span></div>
          </div>
          <div class="body">
            <div class="detail"></div>
            <div class="facts"></div>
            <div class="hintbox"></div>
          </div>
          <div class="actions"></div>
        </div>
      </div>
    </section>

    <section>
      <div class="sec-head"><h2 data-i18n="endpointTitle">Your endpoint</h2></div>
      <div class="endpoint-card">
        <div class="field-label" data-i18n="baseUrl">Base URL</div>
        <div class="endpoint-row">
          <div class="endpoint-url" id="endpointUrl">${endpoint}</div>
          <button class="copy" id="copyBtn" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span class="copy-label" data-i18n="copy">Copy</span>
          </button>
        </div>
        <div class="field-label" style="margin-top:14px" data-i18n="apiKey">API key</div>
        <div class="endpoint-row">
          <div class="endpoint-url" id="apiKeyField">—</div>
          <button class="copy" id="copyKeyBtn" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span class="copy-label" data-i18n="copy">Copy</span>
          </button>
          <button class="copy rotate" id="rotateKeyBtn" type="button" title="Generate a new key" data-i18n-title="rotateTitle">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
            <span class="rotate-label" data-i18n="rotate">Rotate</span>
          </button>
        </div>
        <p class="endpoint-note" id="rotateNote" style="display:none;color:var(--accent)" data-i18n="rotateNote">New key generated — update this key in your client.</p>
        <p class="endpoint-note" data-i18n-html="endpointOpenAi"><b>OpenAI-compatible</b> clients: use this Base URL — the gateway serves <code>/chat/completions</code> + <code>/models</code>. In Clawso, add it as a <b>Custom (OpenAI-compatible)</b> provider with this Base URL and the key.</p>
        <p class="endpoint-note" data-i18n-html="endpointAnthropic"><b>Anthropic-compatible</b> clients: same Base URL — the gateway also serves <code>/messages</code>.</p>
        <p class="endpoint-note" data-i18n-html="endpointKeyHelp">The key works as either <kbd>Authorization: Bearer &lt;key&gt;</kbd> (OpenAI) or <kbd>x-api-key: &lt;key&gt;</kbd> (Anthropic). Each model needs its matching subscription connected above.</p>
      </div>
    </section>

    <section>
      <div class="sec-head">
        <h2 data-i18n="directTestTitle">Direct CLI test</h2>
        <p data-i18n="directTestCopy">Send one prompt through a selected local CLI and model to verify that account can answer now.</p>
      </div>
      <div class="test-card">
        <div class="test-grid">
          <select id="testProvider" aria-label="Provider" data-i18n-aria="providerAria">
            <option value="claude">Claude</option>
            <option value="codex">ChatGPT (Codex)</option>
            <option value="gemini">Gemini</option>
            <option value="antigravity">Antigravity</option>
          </select>
          <select id="testModel" aria-label="Model" data-i18n-aria="modelAria">
            <option value="" data-i18n="providerDefault">Provider default</option>
          </select>
          <input id="testPrompt" type="text" value="Reply with one short confirmation." aria-label="Test prompt" data-i18n-aria="testPromptAria" />
          <button class="btn" id="runTestBtn" type="button" data-i18n="testCli">Test CLI</button>
        </div>
        <div class="test-result" id="testResult"></div>
      </div>
    </section>

    <section>
      <div class="sec-head row">
        <div>
          <h2 data-i18n="modelsTitle">Models</h2>
          <div class="meta" id="modelsMeta" data-i18n="modelsRefreshHint">Refresh to verify which CLI models this OAuth account can use now.</div>
        </div>
        <div class="model-refresh-controls">
          <select id="refreshProvider" aria-label="Refresh provider" data-i18n-aria="refreshProviderAria">
            <option value="all" data-i18n="allProviders">All providers</option>
            <option value="claude">Claude</option>
            <option value="codex">ChatGPT (Codex)</option>
            <option value="gemini">Gemini</option>
            <option value="antigravity">Antigravity</option>
          </select>
          <button class="refresh-models" id="refreshModelsBtn" type="button" data-i18n="refreshModels">Refresh models</button>
        </div>
      </div>
      <div class="models" id="models"><div class="empty" data-i18n="loadingModels">Loading models…</div></div>
    </section>
    </div>

    <div class="tab-panel" id="usagePanel">
      <section>
        <div class="sec-head"><h2 data-i18n="supplierTotals">Supplier totals</h2></div>
        <div class="usage-card">
          <div class="usage-table-wrap" id="usageSummary">
            <div class="usage-empty" data-i18n="noUsage">No usage recorded yet.</div>
          </div>
        </div>
      </section>
      <section>
        <div class="sec-head"><h2 data-i18n="requestLog">Request log</h2></div>
        <div class="usage-card">
          <div class="usage-table-wrap" id="usageLog">
            <div class="usage-empty" data-i18n="noUsage">No usage recorded yet.</div>
          </div>
        </div>
      </section>
    </div>

    <footer data-i18n="footer">Served locally by Meridian Gateway · this page never leaves your machine</footer>
  </div>

<script>
(function () {
  "use strict";
  var POLL_MS = 2000;
  var IDLE_REFRESH_MS = 6000;
  var VERSION_REFRESH_MS = 120000;
  var BACKED_BY = {
    "anthropic-subscription": { id: "claude", label: "Claude" },
    "openai-subscription":    { id: "codex",  label: "ChatGPT" },
    "gemini-subscription":    { id: "gemini", label: "Gemini" },
    "antigravity-subscription": { id: "antigravity", label: "Antigravity" }
  };
  var PROVIDERS = ["claude", "codex", "gemini", "antigravity"];
  var LABELS = { claude: "Claude", codex: "ChatGPT", gemini: "Gemini", antigravity: "Antigravity" };
  // The npm-global package for each provider's CLI — used only for the manual
  // copy-the-command fallback shown when automatic install fails.
  var PACKAGES = {
    claude: "@anthropic-ai/claude-code",
    codex:  "@openai/codex",
    gemini: "@google/gemini-cli",
    antigravity: "Google Antigravity app"
  };
  var INSTALL_COMMANDS = {
    claude: "npm install -g @anthropic-ai/claude-code",
    codex: "npm install -g @openai/codex",
    gemini: "npm install -g @google/gemini-cli",
    antigravity: "curl -fsSL https://antigravity.google/cli/install.sh | bash"
  };
  var pollTimers = {};
  // While a card is mid-setup/connect we suppress status re-renders that would
  // clobber the spinner/hint with a stale "Set up"/"Connect" button.
  var busy = {};
  var modelCache = [];
  var versionCache = {};
  var activeTab = "setup";
  var lastStatus = null;
  var lastModelPayload = null;
  var lastUsagePayload = null;
  var LANG_STORAGE_KEY = "meridian.gateway.language";
  var I18N = {
    en: {
      pageTitle: "Meridian Gateway",
      subtitle: "Local OpenAI- & Anthropic-compatible endpoint",
      languageLabel: "Language",
      running: "Running",
      gatewayPages: "Gateway pages",
      tabSetup: "Setup",
      tabUsage: "Usage",
      connectTitle: "Connect your AI subscriptions",
      connectCopy: "Sign in to the subscriptions you already pay for. Each model below uses its matching account — no API keys needed.",
      checking: "Checking…",
      endpointTitle: "Your endpoint",
      baseUrl: "Base URL",
      apiKey: "API key",
      copy: "Copy",
      copied: "Copied!",
      rotate: "Rotate",
      rotateTitle: "Generate a new key",
      rotateNote: "New key generated — update this key in your client.",
      endpointOpenAi: "<b>OpenAI-compatible</b> clients: use this Base URL — the gateway serves <code>/chat/completions</code> + <code>/models</code>. In Clawso, add it as a <b>Custom (OpenAI-compatible)</b> provider with this Base URL and the key.",
      endpointAnthropic: "<b>Anthropic-compatible</b> clients: same Base URL — the gateway also serves <code>/messages</code>.",
      endpointKeyHelp: "The key works as either <kbd>Authorization: Bearer &lt;key&gt;</kbd> (OpenAI) or <kbd>x-api-key: &lt;key&gt;</kbd> (Anthropic). Each model needs its matching subscription connected above.",
      directTestTitle: "Direct CLI test",
      directTestCopy: "Send one prompt through a selected local CLI and model to verify that account can answer now.",
      providerAria: "Provider",
      modelAria: "Model",
      providerDefault: "Provider default",
      testPromptAria: "Test prompt",
      testPromptDefault: "Reply with one short confirmation.",
      testCli: "Test CLI",
      modelsTitle: "Models",
      refreshModels: "Refresh models",
      refreshProviderAria: "Refresh provider",
      allProviders: "All providers",
      refreshingModels: "Refreshing…",
      modelsRefreshHint: "Refresh to verify which CLI models this OAuth account can use now.",
      modelsRefreshed: "Models refreshed.",
      modelsRefreshFailed: "Couldn’t refresh models.",
      loadingModels: "Loading models…",
      noModels: "No live models available from connected providers.",
      modelsLoadFailed: "Couldn’t load models — is the gateway still running?",
      supplierTotals: "Supplier totals",
      requestLog: "Request log",
      noUsage: "No usage recorded yet.",
      usageLoadFailed: "Couldn’t load usage.",
      footer: "Served locally by Meridian Gateway · this page never leaves your machine",
      connected: "Connected",
      notInstalled: "Not installed",
      notConnected: "Not connected",
      setUp: "Set up",
      connect: "Connect",
      logOut: "Log out",
      updateCli: "Update CLI",
      installing: "Installing…",
      updatingCli: "Updating…",
      opening: "Opening…",
      signingOut: "Signing out…",
      testing: "Testing…",
      installingHint: "Installing {provider}… this can take a minute.",
      updateCliHint: "Updating {provider} CLI… this can take a minute.",
      antigravityInstallHint: "Installing Antigravity with Google's official CLI installer:",
      antigravityUpdateHint: "Updating Antigravity with Google's official CLI installer:",
      updatedCli: "{provider} CLI updated.",
      installFallbackLead: "Couldn’t install automatically — run this once:",
      updateFallbackLead: "Couldn’t update automatically — run this once:",
      installNetworkError: "Network error while installing.",
      updateNetworkError: "Network error while updating.",
      manualSignIn: "Sign in manually to connect.",
      antigravityTerminalLoginHint: "Opened Antigravity sign-in without Terminal. Complete Google OAuth in the browser, paste the authorization code here, and this page updates automatically once agy models works.",
      antigravityManualLoginHint: "Could not start Antigravity sign-in automatically. Copy this command into Terminal, then complete the Antigravity sign-in prompts. This page updates automatically once agy models works.",
      openAuthPage: "Open Google OAuth page",
      authCodePlaceholder: "Paste authorization code",
      submitAuthCode: "Submit code",
      authCodeSubmitted: "Code submitted. Waiting for Antigravity to finish sign-in…",
      authCodeFailed: "Couldn’t submit the code. Start sign-in again.",
      openingBrowser: "Opening your browser — finish signing in there; this updates automatically.",
      openingBrowserLink: " If it didn’t open, <a href=\\\"{url}\\\" target=\\\"_blank\\\" rel=\\\"noopener\\\">use this link</a>.",
      signInFailed: "Couldn’t start sign-in. Please try again.",
      signingOutHint: "Signing out of {provider}…",
      signedOut: "Signed out. Connect again to choose an account.",
      signOutFailed: "Couldn’t sign out. Please try again.",
      inputNeeded: "Input needed",
      promptRequired: "Prompt is required.",
      runningProvider: "Running {provider}",
      waitingForCli: "Waiting for the local CLI response…",
      cliTestFailed: "CLI test failed.",
      requestFailed: "Request failed",
      networkError: "Network error",
      factAccount: "Account",
      factPlan: "Plan",
      factAuth: "Auth",
      factCredential: "Credential",
      factNote: "Note",
      factCli: "CLI",
      cliLatestVersion: "latest {version}",
      unknown: "Unknown",
      durationMs: "{value} ms",
      usageSupplier: "Supplier",
      usageRequests: "Requests",
      usageInput: "Input",
      usageOutput: "Output",
      usageTokenTotal: "Token total",
      usageAvgResponse: "Avg response",
      usageLatest: "Latest",
      usageTime: "Time",
      usageModel: "Model",
      usageSurface: "Surface",
      usageResponseTime: "Response time",
      codexLimitation: "Subscription tier is not exposed by Codex CLI status.",
      geminiLimitation: "Subscription tier is not exposed by Gemini CLI status.",
      antigravityLimitation: "Subscription tier is not exposed by Antigravity CLI status."
    },
    "zh-CN": {
      pageTitle: "Meridian Gateway",
      subtitle: "本地 OpenAI 与 Anthropic 兼容端点",
      languageLabel: "语言",
      running: "运行中",
      gatewayPages: "Gateway 页面",
      tabSetup: "设置",
      tabUsage: "用量",
      connectTitle: "连接你的 AI 订阅",
      connectCopy: "登录你已经付费的订阅。下面的每个模型都会使用对应账号，无需 API key。",
      checking: "检查中…",
      endpointTitle: "你的端点",
      baseUrl: "Base URL",
      apiKey: "访问密钥",
      copy: "复制",
      copied: "已复制",
      rotate: "轮换",
      rotateTitle: "生成新密钥",
      rotateNote: "已生成新密钥，请在客户端更新。",
      endpointOpenAi: "<b>OpenAI 兼容</b>客户端：使用这个 Base URL。Gateway 提供 <code>/chat/completions</code> 和 <code>/models</code>。在 Clawso 中，将它添加为 <b>Custom (OpenAI-compatible)</b> provider，并填入此 Base URL 与密钥。",
      endpointAnthropic: "<b>Anthropic 兼容</b>客户端：使用同一个 Base URL。Gateway 也提供 <code>/messages</code>。",
      endpointKeyHelp: "密钥可作为 <kbd>Authorization: Bearer &lt;key&gt;</kbd> (OpenAI) 或 <kbd>x-api-key: &lt;key&gt;</kbd> (Anthropic) 使用。每个模型都需要先连接上方对应的订阅账号。",
      directTestTitle: "直接 CLI 测试",
      directTestCopy: "选择本地 CLI 和模型发送一次 prompt，确认该账号现在可以正常回答。",
      providerAria: "供应商",
      modelAria: "模型",
      providerDefault: "供应商默认",
      testPromptAria: "测试 prompt",
      testPromptDefault: "请用一句简短的话确认。",
      testCli: "测试 CLI",
      modelsTitle: "模型",
      refreshModels: "刷新模型",
      refreshProviderAria: "刷新供应商",
      allProviders: "全部供应商",
      refreshingModels: "刷新中…",
      modelsRefreshHint: "刷新以验证这个 OAuth 账号当前真正可用的 CLI 模型。",
      modelsRefreshed: "模型已刷新。",
      modelsRefreshFailed: "无法刷新模型。",
      loadingModels: "正在加载模型…",
      noModels: "已连接供应商暂无可用实时模型。",
      modelsLoadFailed: "无法加载模型，Gateway 还在运行吗？",
      supplierTotals: "供应商汇总",
      requestLog: "请求日志",
      noUsage: "尚未记录用量。",
      usageLoadFailed: "无法加载用量。",
      footer: "由 Meridian Gateway 本地提供服务 · 此页面不会离开你的机器",
      connected: "已连接",
      notInstalled: "未安装",
      notConnected: "未连接",
      setUp: "设置",
      connect: "连接",
      logOut: "登出",
      updateCli: "更新 CLI",
      installing: "安装中…",
      updatingCli: "更新中…",
      opening: "打开中…",
      signingOut: "登出中…",
      testing: "测试中…",
      installingHint: "正在安装 {provider}… 可能需要一分钟。",
      updateCliHint: "正在更新 {provider} CLI… 可能需要一分钟。",
      antigravityInstallHint: "正在使用 Google 官方 CLI 安装器安装 Antigravity：",
      antigravityUpdateHint: "正在使用 Google 官方 CLI 安装器更新 Antigravity：",
      updatedCli: "{provider} CLI 已更新。",
      installFallbackLead: "无法自动安装，请先运行一次：",
      updateFallbackLead: "无法自动更新，请先运行一次：",
      installNetworkError: "安装时出现网络错误。",
      updateNetworkError: "更新时出现网络错误。",
      manualSignIn: "请手动登录以完成连接。",
      antigravityTerminalLoginHint: "已在不打开 Terminal 的情况下启动 Antigravity 登录。请在浏览器完成 Google OAuth，把授权 code 粘贴到这里；当 agy models 可用后，此页面会自动更新。",
      antigravityManualLoginHint: "无法自动启动 Antigravity 登录。请复制这个命令到 Terminal，然后完成 Antigravity 登录提示；当 agy models 可用后，此页面会自动更新。",
      openAuthPage: "打开 Google OAuth 页面",
      authCodePlaceholder: "粘贴授权 code",
      submitAuthCode: "提交 code",
      authCodeSubmitted: "code 已提交，正在等待 Antigravity 完成登录…",
      authCodeFailed: "无法提交 code。请重新开始登录。",
      openingBrowser: "正在打开浏览器，请在浏览器中完成登录；此处会自动更新。",
      openingBrowserLink: " 如果没有打开，<a href=\\\"{url}\\\" target=\\\"_blank\\\" rel=\\\"noopener\\\">使用此链接</a>。",
      signInFailed: "无法启动登录，请重试。",
      signingOutHint: "正在登出 {provider}…",
      signedOut: "已登出。再次连接即可选择账号。",
      signOutFailed: "无法登出，请重试。",
      inputNeeded: "需要输入",
      promptRequired: "Prompt 不能为空。",
      runningProvider: "正在运行 {provider}",
      waitingForCli: "等待本地 CLI 返回…",
      cliTestFailed: "CLI 测试失败。",
      requestFailed: "请求失败",
      networkError: "网络错误",
      factAccount: "账号",
      factPlan: "套餐",
      factAuth: "授权",
      factCredential: "凭据",
      factNote: "备注",
      factCli: "CLI",
      cliLatestVersion: "最新 {version}",
      unknown: "未知",
      durationMs: "{value} 毫秒",
      usageSupplier: "供应商",
      usageRequests: "请求数",
      usageInput: "输入",
      usageOutput: "输出",
      usageTokenTotal: "Token 总计",
      usageAvgResponse: "平均响应",
      usageLatest: "最近",
      usageTime: "时间",
      usageModel: "模型",
      usageSurface: "接口",
      usageResponseTime: "响应时间",
      codexLimitation: "Codex CLI 状态未暴露订阅套餐。",
      geminiLimitation: "Gemini CLI 状态未暴露订阅套餐。",
      antigravityLimitation: "Antigravity CLI 状态未暴露订阅套餐。"
    },
    ja: {
      pageTitle: "Meridian Gateway",
      subtitle: "ローカルの OpenAI / Anthropic 互換エンドポイント",
      languageLabel: "言語",
      running: "稼働中",
      gatewayPages: "Gateway ページ",
      tabSetup: "設定",
      tabUsage: "使用量",
      connectTitle: "AI サブスクリプションを接続",
      connectCopy: "すでに支払っているサブスクリプションにログインします。各モデルは対応するアカウントを使うため、API key は不要です。",
      checking: "確認中…",
      endpointTitle: "エンドポイント",
      baseUrl: "Base URL",
      apiKey: "アクセスキー",
      copy: "コピー",
      copied: "コピー済み",
      rotate: "更新",
      rotateTitle: "新しいキーを生成",
      rotateNote: "新しいキーを生成しました。クライアント側のキーを更新してください。",
      endpointOpenAi: "<b>OpenAI 互換</b>クライアント: この Base URL を使用します。Gateway は <code>/chat/completions</code> と <code>/models</code> を提供します。Clawso では <b>Custom (OpenAI-compatible)</b> provider として追加し、この Base URL とキーを設定してください。",
      endpointAnthropic: "<b>Anthropic 互換</b>クライアント: 同じ Base URL を使用します。Gateway は <code>/messages</code> も提供します。",
      endpointKeyHelp: "キーは <kbd>Authorization: Bearer &lt;key&gt;</kbd> (OpenAI) または <kbd>x-api-key: &lt;key&gt;</kbd> (Anthropic) として使えます。各モデルには、上で対応するサブスクリプション接続が必要です。",
      directTestTitle: "CLI 直接テスト",
      directTestCopy: "ローカル CLI とモデルを選び、1 回だけ prompt を送って、そのアカウントが今応答できるか確認します。",
      providerAria: "プロバイダー",
      modelAria: "モデル",
      providerDefault: "プロバイダー既定",
      testPromptAria: "テスト prompt",
      testPromptDefault: "短い確認文を一文で返してください。",
      testCli: "CLI をテスト",
      modelsTitle: "モデル",
      refreshModels: "モデルを更新",
      refreshProviderAria: "更新するプロバイダー",
      allProviders: "すべてのプロバイダー",
      refreshingModels: "更新中…",
      modelsRefreshHint: "この OAuth アカウントで今使える CLI モデルを検証します。",
      modelsRefreshed: "モデルを更新しました。",
      modelsRefreshFailed: "モデルを更新できませんでした。",
      loadingModels: "モデルを読み込み中…",
      noModels: "接続済みプロバイダーから利用可能なライブモデルはありません。",
      modelsLoadFailed: "モデルを読み込めませんでした。Gateway はまだ稼働していますか？",
      supplierTotals: "プロバイダー合計",
      requestLog: "リクエストログ",
      noUsage: "使用量はまだ記録されていません。",
      usageLoadFailed: "使用量を読み込めませんでした。",
      footer: "Meridian Gateway がローカルで提供しています · このページはあなたのマシン外へ送信されません",
      connected: "接続済み",
      notInstalled: "未インストール",
      notConnected: "未接続",
      setUp: "設定",
      connect: "接続",
      logOut: "ログアウト",
      updateCli: "CLI を更新",
      installing: "インストール中…",
      updatingCli: "更新中…",
      opening: "起動中…",
      signingOut: "ログアウト中…",
      testing: "テスト中…",
      installingHint: "{provider} をインストールしています… 1 分ほどかかることがあります。",
      updateCliHint: "{provider} CLI を更新しています… 1 分ほどかかることがあります。",
      antigravityInstallHint: "Google 公式 CLI インストーラーで Antigravity をインストールしています:",
      antigravityUpdateHint: "Google 公式 CLI インストーラーで Antigravity を更新しています:",
      updatedCli: "{provider} CLI を更新しました。",
      installFallbackLead: "自動インストールできませんでした。これを一度実行してください:",
      updateFallbackLead: "自動更新できませんでした。これを一度実行してください:",
      installNetworkError: "インストール中にネットワークエラーが発生しました。",
      updateNetworkError: "更新中にネットワークエラーが発生しました。",
      manualSignIn: "接続するには手動でログインしてください。",
      antigravityTerminalLoginHint: "Terminal を開かずに Antigravity のサインインを開始しました。ブラウザで Google OAuth を完了し、認可 code をここに貼り付けてください。agy models が使えるようになると、この画面は自動更新されます。",
      antigravityManualLoginHint: "Antigravity サインインを自動開始できませんでした。このコマンドを Terminal にコピーし、Antigravity のサインイン手順を完了してください。agy models が使えるようになると、この画面は自動更新されます。",
      openAuthPage: "Google OAuth ページを開く",
      authCodePlaceholder: "認可 code を貼り付け",
      submitAuthCode: "code を送信",
      authCodeSubmitted: "code を送信しました。Antigravity のサインイン完了を待っています…",
      authCodeFailed: "code を送信できませんでした。サインインをもう一度開始してください。",
      openingBrowser: "ブラウザを開いています。そこでログインを完了してください。この画面は自動更新されます。",
      openingBrowserLink: " 開かない場合は、<a href=\\\"{url}\\\" target=\\\"_blank\\\" rel=\\\"noopener\\\">このリンク</a>を使ってください。",
      signInFailed: "サインインを開始できませんでした。もう一度お試しください。",
      signingOutHint: "{provider} からログアウトしています…",
      signedOut: "ログアウトしました。別アカウントを選ぶには再接続してください。",
      signOutFailed: "ログアウトできませんでした。もう一度お試しください。",
      inputNeeded: "入力が必要です",
      promptRequired: "Prompt は必須です。",
      runningProvider: "{provider} を実行中",
      waitingForCli: "ローカル CLI の応答を待っています…",
      cliTestFailed: "CLI テストに失敗しました。",
      requestFailed: "リクエスト失敗",
      networkError: "ネットワークエラー",
      factAccount: "アカウント",
      factPlan: "プラン",
      factAuth: "認証",
      factCredential: "資格情報",
      factNote: "注記",
      factCli: "CLI",
      cliLatestVersion: "最新 {version}",
      unknown: "不明",
      durationMs: "{value} ms",
      usageSupplier: "プロバイダー",
      usageRequests: "リクエスト",
      usageInput: "入力",
      usageOutput: "出力",
      usageTokenTotal: "Token 合計",
      usageAvgResponse: "平均応答",
      usageLatest: "最新",
      usageTime: "時刻",
      usageModel: "モデル",
      usageSurface: "サーフェス",
      usageResponseTime: "応答時間",
      codexLimitation: "Codex CLI の状態にはサブスクリプション種別が表示されません。",
      geminiLimitation: "Gemini CLI の状態にはサブスクリプション種別が表示されません。",
      antigravityLimitation: "Antigravity CLI の状態にはサブスクリプション種別が表示されません。"
    }
  };
  var currentLang = readStoredLanguage();

  function el(card, sel) { return card.querySelector(sel); }
  function cardFor(id) { return document.querySelector('.card[data-id="' + id + '"]'); }
  function providerForOwner(owner) {
    var backed = BACKED_BY[owner || ""];
    return backed && backed.id ? backed.id : "";
  }

  function locale() {
    if (currentLang === "zh-CN") return "zh-CN";
    if (currentLang === "ja") return "ja-JP";
    return "en-US";
  }

  function readStoredLanguage() {
    try {
      var saved = window.localStorage && window.localStorage.getItem(LANG_STORAGE_KEY);
      if (saved && I18N[saved]) return saved;
      var browserLang = (navigator.language || "").toLowerCase();
      if (browserLang.indexOf("zh") === 0) return "zh-CN";
      if (browserLang.indexOf("ja") === 0) return "ja";
    } catch (e) {
      // localStorage may be unavailable in hardened browser contexts.
    }
    return "en";
  }

  function t(key, vars) {
    var text = (I18N[currentLang] && I18N[currentLang][key]) || I18N.en[key] || key;
    if (vars) {
      Object.keys(vars).forEach(function (name) {
        text = text.replace(new RegExp("\\{" + name + "\\}", "g"), String(vars[name]));
      });
    }
    return text;
  }

  function defaultPromptValues() {
    return Object.keys(I18N).map(function (lang) { return I18N[lang].testPromptDefault; });
  }

  function localizeKnownValue(value) {
    if (!value) return value;
    var normalized = String(value);
    if (normalized === I18N.en.codexLimitation) return t("codexLimitation");
    if (normalized === I18N.en.geminiLimitation) return t("geminiLimitation");
    if (normalized === I18N.en.antigravityLimitation) return t("antigravityLimitation");
    if (normalized === I18N.en.antigravityTerminalLoginHint) return t("antigravityTerminalLoginHint");
    if (normalized === I18N.en.antigravityManualLoginHint) return t("antigravityManualLoginHint");
    return value;
  }

  function applyLanguage() {
    document.documentElement.lang = currentLang;
    document.title = t("pageTitle");
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n]"), function (node) {
      node.textContent = t(node.getAttribute("data-i18n"));
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-html]"), function (node) {
      node.innerHTML = t(node.getAttribute("data-i18n-html"));
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-title]"), function (node) {
      node.setAttribute("title", t(node.getAttribute("data-i18n-title")));
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-aria]"), function (node) {
      node.setAttribute("aria-label", t(node.getAttribute("data-i18n-aria")));
    });
    var langSelect = document.getElementById("languageSelect");
    if (langSelect) langSelect.value = currentLang;
    var testPrompt = document.getElementById("testPrompt");
    if (testPrompt && (!testPrompt.value || defaultPromptValues().indexOf(testPrompt.value) !== -1)) {
      testPrompt.value = t("testPromptDefault");
    }
    populateTestModels();
    if (lastStatus) {
      PROVIDERS.forEach(function (id) { renderProvider(id, lastStatus[id]); });
    }
    if (lastModelPayload) renderModels(lastModelPayload);
    if (lastUsagePayload) renderUsage(lastUsagePayload);
  }

  function setLanguage(lang) {
    if (!I18N[lang]) lang = "en";
    currentLang = lang;
    try {
      if (window.localStorage) window.localStorage.setItem(LANG_STORAGE_KEY, currentLang);
    } catch (e) {
      // Ignore persistence failures; the selector still works for this page.
    }
    applyLanguage();
  }

  function okBadge() {
    return '<span class="badge-ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' + esc(t("connected")) + '</span>';
  }

  function fact(label, value, warn) {
    if (!value) return "";
    value = localizeKnownValue(value);
    return '<span class="fact' + (warn ? " warn" : "") + '" title="' + esc(label + ": " + value) + '">' + esc(label + ": " + value) + '</span>';
  }

  function versionState(id) {
    return versionCache && versionCache[id] ? versionCache[id] : null;
  }

  function cliVersionFact(id) {
    var version = versionState(id);
    if (!version) return "";
    if (version.installedVersion && version.latestVersion && version.updateAvailable) {
      return version.installedVersion + " -> " + version.latestVersion;
    }
    if (version.installedVersion) return version.installedVersion;
    if (version.latestVersion) return t("cliLatestVersion", { version: version.latestVersion });
    return "";
  }

  function updateButton(id) {
    var version = versionState(id);
    if (!version || !version.updateAvailable) return "";
    return '<button class="update-btn" type="button">' + esc(t("updateCli")) + '</button>';
  }

  function bindUpdateButton(card, id) {
    var btn = el(card, ".actions .update-btn");
    if (btn) btn.addEventListener("click", function () { updateCli(id); });
  }

  function renderFacts(card, id, state) {
    var facts = el(card, ".facts");
    if (!facts) return;
    var version = versionState(id);
    var html = [
      fact(t("factAccount"), state && state.account),
      fact(t("factPlan"), state && state.subscription),
      fact(t("factAuth"), state && state.auth),
      fact(t("factCredential"), state && state.credential),
      fact(t("factCli"), cliVersionFact(id), version && version.updateAvailable),
      fact(t("factNote"), state && state.limitation, true)
    ].filter(Boolean).join("");
    facts.innerHTML = html;
    facts.style.display = html ? "" : "none";
  }

  function renderProvider(id, state) {
    var card = cardFor(id);
    if (!card) return;
    // Don't stomp on an in-flight setup/connect (spinner + hint) for this card.
    if (busy[id]) return;
    var statText = el(card, ".stat-text");
    var detail = el(card, ".detail");
    var actions = el(card, ".actions");
    var installed = !state || state.installed !== false; // default true if field absent
    if (state && state.connected) {
      card.classList.add("connected");
      statText.textContent = t("connected");
      detail.textContent = state.detail || "";
      detail.style.display = state.detail ? "" : "none";
      renderFacts(card, id, state);
      actions.innerHTML = okBadge() + updateButton(id) + '<button class="logout-btn" type="button">' + esc(t("logOut")) + '</button>';
      bindUpdateButton(card, id);
      actions.querySelector(".logout-btn").addEventListener("click", function () { logout(id); });
      hideHint(id);
      stopPoll(id);
    } else if (!installed) {
      // CLI isn't installed on this machine → one-click "Set up" (install).
      card.classList.remove("connected");
      statText.textContent = t("notInstalled");
      detail.textContent = (state && state.detail) || "";
      detail.style.display = (state && state.detail) ? "" : "none";
      renderFacts(card, id, state);
      actions.innerHTML = '<button class="btn" type="button">' + esc(t("setUp")) + '</button>';
      actions.querySelector("button").addEventListener("click", function () { setUp(id); });
    } else {
      // Installed but not connected → existing "Connect" (login only).
      card.classList.remove("connected");
      statText.textContent = t("notConnected");
      detail.textContent = (state && state.detail) || "";
      detail.style.display = (state && state.detail) ? "" : "none";
      renderFacts(card, id, state);
      actions.innerHTML = '<button class="btn" type="button">' + esc(t("connect")) + '</button>' + updateButton(id);
      actions.querySelector(".btn").addEventListener("click", function () { connect(id); });
      bindUpdateButton(card, id);
    }
  }

  function showHint(id, html, withSpinner) {
    var card = cardFor(id);
    if (!card) return;
    var box = el(card, ".hintbox");
    box.innerHTML = (withSpinner ? '<span class="spin"></span>' : "") + html;
    box.classList.add("show");
  }
  function hideHint(id) {
    var card = cardFor(id);
    if (!card) return;
    var box = el(card, ".hintbox");
    box.classList.remove("show");
    box.innerHTML = "";
  }

  var COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

  // Manual command fallback: short message + the exact command with a copy button.
  function showCommandFallback(id, lead, errMsg, command) {
    var card = cardFor(id);
    if (!card) return;
    var cmd = command || INSTALL_COMMANDS[id] || ("npm install -g " + (PACKAGES[id] || ""));
    var extra = errMsg ? '<div class="err" style="margin-top:7px;font-size:12px;color:var(--faint)">' + esc(errMsg) + "</div>" : "";
    showHint(id,
      esc(lead) +
      '<div class="cmd-row"><span class="cmd">' + esc(cmd) + '</span>' +
      '<button class="cmd-copy" type="button">' + COPY_ICON + '<span class="cmd-copy-label">' + esc(t("copy")) + '</span></button></div>' +
      extra,
      false);
    var btn = el(card, ".hintbox .cmd-copy");
    if (btn) btn.addEventListener("click", function () { copyText(cmd, btn); });
  }

  function showAuthCodePrompt(id, lead, url, jobId) {
    var card = cardFor(id);
    if (!card) return;
    var link = url
      ? '<div style="margin-top:8px"><a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(t("openAuthPage")) + '</a></div>'
      : "";
    showHint(id,
      esc(lead) +
      link +
      '<div class="auth-code-row">' +
      '<input class="auth-code-input" type="password" autocomplete="one-time-code" placeholder="' + esc(t("authCodePlaceholder")) + '" />' +
      '<button class="auth-code-submit" type="button">' + esc(t("submitAuthCode")) + '</button>' +
      '</div>',
      false);
    var input = el(card, ".hintbox .auth-code-input");
    var submit = el(card, ".hintbox .auth-code-submit");
    var send = function () {
      var code = input && input.value ? input.value.trim() : "";
      if (!code) return;
      if (submit) submit.disabled = true;
      fetch("/providers/antigravity/login/" + encodeURIComponent(jobId) + "/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code })
      })
        .then(function (r) {
          return r.json().then(function (res) { return { ok: r.ok, res: res }; });
        })
        .then(function (payload) {
          if (!payload.ok || !payload.res || !payload.res.ok) throw new Error("submit failed");
          showHint(id, esc(t("authCodeSubmitted")), true);
          startPoll(id);
        })
        .catch(function () {
          showHint(id, esc(t("authCodeFailed")), false);
          if (submit) submit.disabled = false;
        });
    };
    if (submit) submit.addEventListener("click", send);
    if (input) {
      input.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") send();
      });
      input.focus();
    }
  }

  // Manual install fallback: restore the Set-up button so the user can retry too.
  function showInstallFallback(id, errMsg, command) {
    var card = cardFor(id);
    if (!card) return;
    showCommandFallback(id, t("installFallbackLead"), errMsg, command);
    // Restore the Set-up button so the user can retry the automatic path too.
    var actions = el(card, ".actions");
    actions.innerHTML = '<button class="btn" type="button">' + esc(t("setUp")) + '</button>';
    actions.querySelector("button").addEventListener("click", function () { setUp(id); });
  }

  function installProgressHint(id, updating) {
    if (id !== "antigravity") {
      return t(updating ? "updateCliHint" : "installingHint", { provider: LABELS[id] || id });
    }
    var key = updating ? "antigravityUpdateHint" : "antigravityInstallHint";
    var cmd = INSTALL_COMMANDS[id];
    return esc(t(key)) + '<div class="cmd-row"><span class="cmd">' + esc(cmd) + '</span></div>';
  }

  function rerenderProvider(id) {
    if (lastStatus && lastStatus[id]) renderProvider(id, lastStatus[id]);
  }

  function updateCli(id) {
    var card = cardFor(id);
    var btn = card && el(card, ".actions .update-btn");
    var version = versionState(id);
    busy[id] = true;
    if (btn) { btn.disabled = true; btn.textContent = t("updatingCli"); }
    showHint(id, installProgressHint(id, true), true);
    fetch("/providers/" + id + "/update", { method: "POST" })
      .then(function (r) {
        return r.json().then(function (res) { return { ok: r.ok, res: res }; });
      })
      .then(function (payload) {
        var res = payload.res || {};
        if (payload.ok && res.installed) {
          if (res.version) versionCache[id] = res.version;
          Promise.all([loadVersions(), refreshStatus(true)]).then(function () {
            busy[id] = false;
            rerenderProvider(id);
            showHint(id, esc(t("updatedCli", { provider: LABELS[id] || id })), false);
            loadModels();
          });
          return;
        }
        busy[id] = false;
        rerenderProvider(id);
        showCommandFallback(id, t("updateFallbackLead"), res.error, res.command || (version && version.updateCommand));
      })
      .catch(function () {
        busy[id] = false;
        rerenderProvider(id);
        showCommandFallback(id, t("updateFallbackLead"), t("updateNetworkError"), version && version.updateCommand);
      });
  }

  // ── Set up: install the CLI, then chain straight into login ──────────────────
  function setUp(id) {
    var card = cardFor(id);
    var btn = card && el(card, ".actions button");
    busy[id] = true;
    if (btn) { btn.disabled = true; btn.textContent = t("installing"); }
    showHint(id, installProgressHint(id, false), true);
    fetch("/providers/" + id + "/install", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.installed) {
          // Installed — chain into the existing browser login flow.
          loadVersions();
          connect(id, true);
        } else {
          busy[id] = false;
          showInstallFallback(id, res && res.error, res && res.command);
        }
      })
      .catch(function () {
        busy[id] = false;
        showInstallFallback(id, t("installNetworkError"), null);
      });
  }

  // chained = true when called straight after a successful install (no button
  // to flip, hint already shown).
  function connect(id, chained) {
    var card = cardFor(id);
    var btn = card && el(card, ".actions button.btn");
    busy[id] = true;
    if (btn) { btn.disabled = true; btn.textContent = t("opening"); }
    fetch("/providers/" + id + "/login", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.needsCode && res.jobId) {
          busy[id] = false;
          showAuthCodePrompt(id, localizeKnownValue(res.hint || t("manualSignIn")), res.url, res.jobId);
          if (btn) { btn.disabled = false; btn.textContent = t("connect"); }
          startPoll(id);
          return;
        }
        if (res && res.manual) {
          busy[id] = false;
          if (res.command) {
            showCommandFallback(id, localizeKnownValue(res.hint || t("manualSignIn")), null, res.command);
          } else {
            showHint(id, esc(localizeKnownValue(res.hint || t("manualSignIn"))), false);
          }
          if (btn) { btn.disabled = false; btn.textContent = t("connect"); }
          startPoll(id);
          return;
        }
        var msg = res && res.hint ? esc(localizeKnownValue(res.hint)) : t("openingBrowser");
        if (res && res.command) {
          showCommandFallback(id, localizeKnownValue(res.hint || t("manualSignIn")), null, res.command);
        } else if (res && res.url) {
          msg += t("openingBrowserLink", { url: esc(res.url) });
          showHint(id, msg, true);
        } else {
          showHint(id, msg, true);
        }
        // Allow status polling to take over the card now that login is in flight.
        busy[id] = false;
        startPoll(id);
      })
      .catch(function () {
        busy[id] = false;
        showHint(id, t("signInFailed"), false);
        if (btn) { btn.disabled = false; btn.textContent = t("connect"); }
      });
  }

  function logout(id) {
    var card = cardFor(id);
    var btn = card && el(card, ".actions .logout-btn");
    busy[id] = true;
    stopPoll(id);
    if (btn) { btn.disabled = true; btn.textContent = t("signingOut"); }
    showHint(id, t("signingOutHint", { provider: LABELS[id] || id }), true);
    fetch("/providers/" + id + "/logout", { method: "POST" })
      .then(function (r) {
        return r.json().then(function (res) { return { ok: r.ok, res: res }; });
      })
      .then(function (payload) {
        busy[id] = false;
        var res = payload.res || {};
        if (payload.ok && res.ok !== false) {
          showHint(id, esc(localizeKnownValue(res.detail || t("signedOut"))), false);
          refreshStatus(true).then(function () { loadModels(); });
          return;
        }
        showHint(id, esc(res.error || t("signOutFailed")), false);
        refreshStatus(true);
      })
      .catch(function () {
        busy[id] = false;
        showHint(id, t("signOutFailed"), false);
        refreshStatus(true);
      });
  }

  function startPoll(id) {
    stopPoll(id);
    pollTimers[id] = setInterval(function () { refreshStatus(true); }, POLL_MS);
  }
  function stopPoll(id) {
    if (pollTimers[id]) { clearInterval(pollTimers[id]); delete pollTimers[id]; }
  }

  function refreshStatus(quiet) {
    return fetch("/providers/status")
      .then(function (r) { return r.json(); })
      .then(function (s) {
        lastStatus = s;
        PROVIDERS.forEach(function (id) { renderProvider(id, s[id]); });
      })
      .catch(function () { if (!quiet) { /* keep last known state on transient errors */ } });
  }

  function loadVersions() {
    return fetch("/providers/versions")
      .then(function (r) { return r.json(); })
      .then(function (versions) {
        versionCache = versions || {};
        if (lastStatus) {
          PROVIDERS.forEach(function (id) { renderProvider(id, lastStatus[id]); });
        }
        return versions;
      })
      .catch(function () { return null; });
  }

  function renderModels(data) {
    var box = document.getElementById("models");
    var list = (data && data.data) || [];
    var errors = data && data.errors ? data.errors : null;
    lastModelPayload = data;
    modelCache = list;
    populateTestModels();
    if (data && data.refreshedAt) {
      setModelsMeta(t("modelsRefreshed") + " " + fmtTime(data.refreshedAt));
    } else {
      setModelsMeta(t("modelsRefreshHint"));
    }
    var errorHtml = renderModelErrors(errors);
    if (!list.length) {
      box.innerHTML = '<div class="empty">' + esc(t("noModels")) + '</div>' + errorHtml;
      return;
    }
    box.innerHTML = list.map(function (m) {
      var b = BACKED_BY[m.owned_by] || { id: "", label: (m.owned_by || "?") };
      return '<div class="model-row"><span class="mid">' + esc(m.id) + '</span>' +
             '<span class="by ' + b.id + '">' + esc(b.label) + '</span></div>';
    }).join("") + errorHtml;
  }

  function renderModelErrors(errors) {
    if (!errors) return "";
    var rows = PROVIDERS.map(function (id) {
      return errors[id] ? '<div><b>' + esc(LABELS[id] || id) + '</b>: ' + esc(errors[id]) + '</div>' : "";
    }).filter(Boolean);
    return rows.length ? '<div class="model-errors">' + rows.join("") + '</div>' : "";
  }

  function setModelsMeta(message) {
    var meta = document.getElementById("modelsMeta");
    if (meta) meta.textContent = message || t("modelsRefreshHint");
  }

  function populateTestModels() {
    var providerEl = document.getElementById("testProvider");
    var modelEl = document.getElementById("testModel");
    if (!providerEl || !modelEl) return;
    var provider = providerEl.value || "claude";
    var current = modelEl.value;
    var matching = modelCache.filter(function (m) { return providerForOwner(m.owned_by) === provider; });
    var html = '<option value="">' + esc(t("providerDefault")) + '</option>' + matching.map(function (m) {
      return '<option value="' + esc(m.id) + '">' + esc(m.id) + '</option>';
    }).join("");
    modelEl.innerHTML = html;
    if (current && matching.some(function (m) { return m.id === current; })) {
      modelEl.value = current;
    }
  }

  function loadModels() {
    return fetch("/v1/models")
      .then(function (r) { return r.json(); })
      .then(renderModels)
      .catch(function () {
        document.getElementById("models").innerHTML = '<div class="empty">' + esc(t("modelsLoadFailed")) + '</div>';
        setModelsMeta(t("modelsLoadFailed"));
      });
  }

  function refreshProviderValue() {
    var select = document.getElementById("refreshProvider");
    var value = select && select.value ? select.value : "all";
    return PROVIDERS.indexOf(value) >= 0 || value === "all" ? value : "all";
  }

  function refreshModels() {
    var btn = document.getElementById("refreshModelsBtn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = t("refreshingModels");
    }
    setModelsMeta(t("refreshingModels"));
    return fetch("/models/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: refreshProviderValue() })
    })
      .then(function (r) {
        return r.json().then(function (res) {
          if (!r.ok) throw new Error((res && res.error && res.error.message) || t("modelsRefreshFailed"));
          return res;
        });
      })
      .then(function () {
        setModelsMeta(t("modelsRefreshed"));
        return loadModels();
      })
      .catch(function () {
        setModelsMeta(t("modelsRefreshFailed"));
      })
      .then(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = t("refreshModels");
        }
      });
  }

  function fmtTokens(value) {
    var n = Number(value || 0);
    return n.toLocaleString(locale());
  }

  function fmtDuration(value) {
    var n = Number(value || 0);
    return t("durationMs", { value: n.toLocaleString(locale()) });
  }

  function fmtTime(value) {
    if (!value) return "—";
    try {
      return new Date(value).toLocaleString(locale());
    } catch (e) {
      return String(value);
    }
  }

  function providerChip(provider) {
    var label = LABELS[provider] || provider || t("unknown");
    return '<span class="usage-provider ' + esc(provider || "") + '">' + esc(label) + '</span>';
  }

  function renderUsageSummary(rows) {
    var box = document.getElementById("usageSummary");
    rows = rows || [];
    if (!rows.length) {
      box.innerHTML = '<div class="usage-empty">' + esc(t("noUsage")) + '</div>';
      return;
    }
    box.innerHTML = '<table class="usage-table"><thead><tr>' +
      '<th>' + esc(t("usageSupplier")) + '</th><th class="number">' + esc(t("usageRequests")) + '</th><th class="number">' + esc(t("usageInput")) + '</th>' +
      '<th class="number">' + esc(t("usageOutput")) + '</th><th class="number">' + esc(t("usageTokenTotal")) + '</th>' +
      '<th class="number">' + esc(t("usageAvgResponse")) + '</th><th>' + esc(t("usageLatest")) + '</th></tr></thead><tbody>' +
      rows.map(function (row) {
        return '<tr><td>' + providerChip(row.provider) + '</td>' +
          '<td class="number">' + fmtTokens(row.requests) + '</td>' +
          '<td class="number">' + fmtTokens(row.promptTokens) + '</td>' +
          '<td class="number">' + fmtTokens(row.completionTokens) + '</td>' +
          '<td class="number">' + fmtTokens(row.totalTokens) + '</td>' +
          '<td class="number">' + fmtDuration(row.averageDurationMs) + '</td>' +
          '<td>' + esc(fmtTime(row.latestAt)) + '</td></tr>';
      }).join("") + '</tbody></table>';
  }

  function renderUsageLog(rows) {
    var box = document.getElementById("usageLog");
    rows = rows || [];
    if (!rows.length) {
      box.innerHTML = '<div class="usage-empty">' + esc(t("noUsage")) + '</div>';
      return;
    }
    box.innerHTML = '<table class="usage-table"><thead><tr>' +
      '<th>' + esc(t("usageTime")) + '</th><th>' + esc(t("usageSupplier")) + '</th><th>' + esc(t("usageModel")) + '</th><th>' + esc(t("usageSurface")) + '</th>' +
      '<th class="number">' + esc(t("usageInput")) + '</th><th class="number">' + esc(t("usageOutput")) + '</th><th class="number">' + esc(t("usageTokenTotal")) + '</th>' +
      '<th class="number">' + esc(t("usageResponseTime")) + '</th></tr></thead><tbody>' +
      rows.map(function (row) {
        return '<tr><td>' + esc(fmtTime(row.timestamp)) + '</td>' +
          '<td>' + providerChip(row.provider) + '</td>' +
          '<td class="model">' + esc(row.model || "—") + '</td>' +
          '<td>' + esc(row.surface || "—") + '</td>' +
          '<td class="number">' + fmtTokens(row.promptTokens) + '</td>' +
          '<td class="number">' + fmtTokens(row.completionTokens) + '</td>' +
          '<td class="number">' + fmtTokens(row.totalTokens) + '</td>' +
          '<td class="number">' + fmtDuration(row.durationMs) + '</td></tr>';
      }).join("") + '</tbody></table>';
  }

  function renderUsage(data) {
    lastUsagePayload = data;
    renderUsageSummary((data && data.summary) || []);
    renderUsageLog((data && data.log) || []);
  }

  function loadUsage() {
    fetch("/usage")
      .then(function (r) { return r.json(); })
      .then(renderUsage)
      .catch(function () {
        document.getElementById("usageSummary").innerHTML = '<div class="usage-empty">' + esc(t("usageLoadFailed")) + '</div>';
        document.getElementById("usageLog").innerHTML = '<div class="usage-empty">' + esc(t("usageLoadFailed")) + '</div>';
      });
  }

  function switchTab(name) {
    activeTab = name || "setup";
    Array.prototype.forEach.call(document.querySelectorAll(".tab-btn"), function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-tab") === activeTab);
    });
    document.getElementById("setupPanel").classList.toggle("active", activeTab === "setup");
    document.getElementById("usagePanel").classList.toggle("active", activeTab === "usage");
    if (activeTab === "usage") loadUsage();
  }

  function setTestResult(html, isError) {
    var result = document.getElementById("testResult");
    if (!result) return;
    result.innerHTML = html;
    result.classList.add("show");
    if (isError) result.classList.add("error");
    else result.classList.remove("error");
  }

  function runDirectTest() {
    var providerEl = document.getElementById("testProvider");
    var modelEl = document.getElementById("testModel");
    var promptEl = document.getElementById("testPrompt");
    var btn = document.getElementById("runTestBtn");
    var provider = providerEl && providerEl.value ? providerEl.value : "claude";
    var prompt = promptEl && promptEl.value ? promptEl.value.trim() : "";
    if (!prompt) {
      setTestResult('<span class="meta">' + esc(t("inputNeeded")) + '</span>' + esc(t("promptRequired")), true);
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = t("testing");
    }
    setTestResult('<span class="meta">' + esc(t("runningProvider", { provider: LABELS[provider] || provider })) + '</span>' + esc(t("waitingForCli")), false);
    fetch('/providers/' + provider + '/test', {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: prompt,
        model: modelEl && modelEl.value ? modelEl.value : undefined
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.ok) {
          var meta = (LABELS[provider] || provider) + (res.model ? " · " + res.model : "");
          setTestResult('<span class="meta">' + esc(meta) + '</span>' + esc(res.text || ""), false);
          loadUsage();
        } else {
          setTestResult('<span class="meta">' + esc(LABELS[provider] || provider) + '</span>' + esc((res && res.error) || t("cliTestFailed")), true);
        }
      })
      .catch(function (err) {
        setTestResult('<span class="meta">' + esc(t("requestFailed")) + '</span>' + esc(err && err.message ? err.message : t("networkError")), true);
      })
      .then(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = t("testCli");
        }
      });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Generic copy-to-clipboard for the endpoint + key fields. Shows a transient
  // "Copied!" state on the triggering button.
  function copyText(text, btn) {
    var label = btn.querySelector(".copy-label, .cmd-copy-label");
    var prev = label ? label.textContent : "";
    var mark = function () {
      btn.classList.add("done");
      if (label) label.textContent = t("copied");
      setTimeout(function () { btn.classList.remove("done"); if (label) label.textContent = prev; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(mark, function () { legacyCopy(text, mark); });
    } else {
      legacyCopy(text, mark);
    }
  }
  function legacyCopy(text, cb) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); document.execCommand("copy");
      document.body.removeChild(ta); cb();
    } catch (e) { /* clipboard unavailable in this iframe */ }
  }

  // Copy endpoint base URL.
  var copyBtn = document.getElementById("copyBtn");
  copyBtn.addEventListener("click", function () {
    copyText(document.getElementById("endpointUrl").textContent.trim(), copyBtn);
  });

  var testProviderEl = document.getElementById("testProvider");
  var runTestBtn = document.getElementById("runTestBtn");
  var testPromptEl = document.getElementById("testPrompt");
  var refreshModelsBtn = document.getElementById("refreshModelsBtn");
  var languageSelect = document.getElementById("languageSelect");
  if (languageSelect) languageSelect.addEventListener("change", function () { setLanguage(languageSelect.value); });
  if (testProviderEl) testProviderEl.addEventListener("change", populateTestModels);
  if (runTestBtn) runTestBtn.addEventListener("click", runDirectTest);
  if (refreshModelsBtn) refreshModelsBtn.addEventListener("click", refreshModels);
  if (testPromptEl) {
    testPromptEl.addEventListener("keydown", function (event) {
      if (event.key === "Enter") runDirectTest();
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll(".tab-btn"), function (btn) {
    btn.addEventListener("click", function () {
      switchTab(btn.getAttribute("data-tab") || "setup");
    });
  });

  // ── API key: load, copy, rotate ─────────────────────────────────────────────
  var apiKeyField = document.getElementById("apiKeyField");
  var copyKeyBtn = document.getElementById("copyKeyBtn");
  var rotateKeyBtn = document.getElementById("rotateKeyBtn");
  var rotateNote = document.getElementById("rotateNote");
  var currentKey = "";

  function setKey(k) {
    currentKey = k || "";
    apiKeyField.textContent = currentKey || "—";
  }

  function loadKey() {
    fetch("/key")
      .then(function (r) { return r.json(); })
      .then(function (res) { setKey(res && res.key); })
      .catch(function () { /* leave placeholder if unreachable */ });
  }

  copyKeyBtn.addEventListener("click", function () {
    if (currentKey) copyText(currentKey, copyKeyBtn);
  });

  rotateKeyBtn.addEventListener("click", function () {
    var rlabel = rotateKeyBtn.querySelector(".rotate-label");
    rotateKeyBtn.disabled = true;
    if (rlabel) rlabel.textContent = "…";
    fetch("/key/rotate", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        setKey(res && res.key);
        if (rotateNote) rotateNote.style.display = "";
      })
      .catch(function () { /* keep the old displayed key on failure */ })
      .then(function () {
        rotateKeyBtn.disabled = false;
        if (rlabel) rlabel.textContent = t("rotate");
      });
  });

  // Initial load + gentle idle auto-refresh (independent of per-provider polls).
  applyLanguage();
  refreshStatus(true);
  loadVersions();
  loadModels();
  loadKey();
  setInterval(function () { refreshStatus(true); }, IDLE_REFRESH_MS);
  setInterval(loadVersions, VERSION_REFRESH_MS);
  setInterval(function () { if (activeTab === "usage") loadUsage(); }, IDLE_REFRESH_MS);
})();
</script>
</body>
</html>`;
}
