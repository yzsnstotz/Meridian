// Meridian Gateway — deterministic CLI resolution.
//
// WHY THIS EXISTS (production incident, 2026-07):
// Every gateway provider used to `spawn("codex" | "claude" | "gemini" | "agy", …)`
// — a BARE command resolved through whatever PATH the gateway process happened to
// inherit. On a box with TWO `@openai/codex` installs, the gateway's PATH ranked a
// STALE/BROKEN one (fnm-global 0.128.0, missing native binary → `spawn … ENOENT`)
// AHEAD of the user's working `~/.local/bin/codex`. Every request ENOENT'd; the
// gateway then crashed the already-open client stream on `write EPIPE`, and the
// client saw a generic "Connection error". A stale duplicate silently shadowed the
// real CLI.
//
// THE FIX: resolve each CLI to an ABSOLUTE, VERIFIED path ONCE, deterministically:
//   1. Honor an explicit env override (`MERIDIAN_<PROVIDER>_BIN`) if it verifies.
//   2. Otherwise walk an ordered candidate list (PATH entries + common install
//      dirs) and pick the FIRST candidate whose binary actually RUNS
//      (`<path> --version` exits cleanly) — so a stale/broken duplicate that
//      ENOENTs or crashes is skipped, not selected.
//   3. Cache the winner. If NOTHING is usable, cache the failure and surface a
//      clear, actionable error at spawn time instead of a raw per-request ENOENT.
//
// This is intentionally standalone (no imports from login.ts) so the resolution
// contract is testable in isolation and cannot be shadowed by PATH mutation order.
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export type CliProvider = "codex" | "claude" | "gemini" | "antigravity";

/** The bare binary name each provider historically spawned. */
const PROVIDER_BINARY: Record<CliProvider, string> = {
  codex: "codex",
  claude: "claude",
  gemini: "gemini",
  antigravity: "agy",
};

/** Env var that lets an operator pin an absolute path per provider. */
const PROVIDER_ENV_OVERRIDE: Record<CliProvider, string> = {
  codex: "MERIDIAN_CODEX_BIN",
  claude: "MERIDIAN_CLAUDE_BIN",
  gemini: "MERIDIAN_GEMINI_BIN",
  antigravity: "MERIDIAN_ANTIGRAVITY_BIN",
};

export interface ResolvedCli {
  /** The verified absolute path to spawn, or null when nothing usable was found. */
  path: string | null;
  /** Actionable reason when `path` is null (safe to log / surface to the caller). */
  error?: string;
  /** The candidate paths that were probed, for diagnostics. */
  probed: string[];
  /** The resolved `<bin> --version` output (trimmed), when a binary verified. */
  version?: string;
}

const cache = new Map<CliProvider, ResolvedCli>();

/**
 * Common install locations for globally-installed coding CLIs, in priority order.
 * `~/.local/bin` is listed BEFORE fnm/nvm shim dirs on purpose: the incident CLI
 * lived in an fnm node-version bin that shadowed the user's real `~/.local/bin`
 * install. We prefer the stable user-local install, but ultimately we verify
 * every candidate anyway, so a broken high-priority entry is skipped regardless.
 */
function commonBinDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
}

/** True when `p` exists, is a file (or symlink to one), and is executable. */
function isExecutableFile(p: string): boolean {
  try {
    if (!existsSync(p)) return false;
    const st = statSync(p); // follows symlinks
    if (!st.isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the ordered, de-duplicated candidate absolute paths for `bin`:
 * every PATH entry joined with `bin`, then the common install dirs. Non-absolute
 * PATH entries are skipped (spawn semantics require an absolute path to be
 * deterministic).
 */
function candidatePaths(bin: string): string[] {
  const dirs: string[] = [];
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    const trimmed = entry.trim();
    if (trimmed && isAbsolute(trimmed)) dirs.push(trimmed);
  }
  dirs.push(...commonBinDirs());
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    const full = join(dir, bin);
    if (!seen.has(full)) {
      seen.add(full);
      out.push(full);
    }
  }
  return out;
}

/**
 * Verify a binary actually runs by invoking `<path> --version`. A stale install
 * whose native binary is missing throws ENOENT (or exits non-zero) here and is
 * treated as unusable. Returns the trimmed version string on success, or null.
 */
function verifyBinary(p: string): string | null {
  try {
    const out = execFileSync(p, ["--version"], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    // A usable CLI prints *something*; empty stdout with exit 0 is acceptable too
    // (some CLIs print the version to stderr), so we accept any clean exit.
    return (out ?? "").trim();
  } catch {
    return null;
  }
}

function resolveProvider(provider: CliProvider): ResolvedCli {
  const bin = PROVIDER_BINARY[provider];
  const probed: string[] = [];

  // 1. Explicit env override wins — but it must still verify, so a bad override
  //    fails loud rather than reintroducing the shadowing bug through config.
  const overridePath = (process.env[PROVIDER_ENV_OVERRIDE[provider]] ?? "").trim();
  if (overridePath) {
    probed.push(overridePath);
    if (isAbsolute(overridePath) && isExecutableFile(overridePath)) {
      const version = verifyBinary(overridePath);
      if (version !== null) {
        return { path: overridePath, probed, version };
      }
    }
    return {
      path: null,
      probed,
      error:
        `${PROVIDER_ENV_OVERRIDE[provider]}=${overridePath} is set but the binary is not usable ` +
        `(missing, non-executable, or \`${overridePath} --version\` failed). Fix the override or unset it.`,
    };
  }

  // 2. Walk ordered candidates; the first one that actually RUNS wins.
  for (const candidate of candidatePaths(bin)) {
    if (!isExecutableFile(candidate)) continue;
    probed.push(candidate);
    const version = verifyBinary(candidate);
    if (version !== null) {
      return { path: candidate, probed, version };
    }
    // Executable existed but `--version` failed (the incident's stale duplicate):
    // keep walking so a working install further down the list can win.
  }

  // 3. Nothing usable — cache a clear, actionable failure.
  return {
    path: null,
    probed,
    error:
      `No usable \`${bin}\` CLI found for the ${provider} provider. ` +
      (probed.length
        ? `Probed but none passed \`--version\`: ${probed.join(", ")}. `
        : `No \`${bin}\` executable was found on PATH or in common install dirs. `) +
      `Install it and/or set ${PROVIDER_ENV_OVERRIDE[provider]} to an absolute path.`,
  };
}

/**
 * Resolve (and cache) the absolute, verified CLI path for a provider. Resolution
 * runs once per provider per process; call `resetCliResolverCache()` in tests to
 * force re-resolution.
 */
export function resolveCli(provider: CliProvider): ResolvedCli {
  const cached = cache.get(provider);
  if (cached) return cached;
  const resolved = resolveProvider(provider);
  cache.set(provider, resolved);
  return resolved;
}

/**
 * Resolve a provider's CLI or throw a clear, actionable error. Provider modules
 * call this at the top of a spawn so a resolution failure surfaces as a clean
 * gateway error string (mapped to the provider's error result) rather than a raw
 * per-request ENOENT from `spawn`.
 */
export function resolveCliOrThrow(provider: CliProvider): string {
  const resolved = resolveCli(provider);
  if (!resolved.path) {
    throw new Error(resolved.error ?? `Could not resolve the ${provider} CLI`);
  }
  return resolved.path;
}

/** Clear the resolution cache (tests + activation re-probe). */
export function resetCliResolverCache(): void {
  cache.clear();
}

/**
 * Eagerly resolve every provider CLI at startup/activation and return a report.
 * Logs are the caller's responsibility; this just performs the (cached) probes so
 * a broken environment is discovered before the first request, not per-request.
 */
export function resolveAllClis(): Record<CliProvider, ResolvedCli> {
  return {
    codex: resolveCli("codex"),
    claude: resolveCli("claude"),
    gemini: resolveCli("gemini"),
    antigravity: resolveCli("antigravity"),
  };
}
