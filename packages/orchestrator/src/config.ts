import * as fs from "node:fs";
import path from "node:path";

import { resolveMeridianPaths } from "@meridian/contracts";

// meridian-roles runtime configuration
// All values overridable via environment variables — no hard-coded production paths

const ENV_FILENAMES = [".env", ".env.local"];

const bootstrapPaths = resolveMeridianPaths();
loadEnvFiles(bootstrapPaths.configDir);
export const orchestratorPaths = resolveMeridianPaths();

// State files placed under macOS /tmp survive only until the next reboot, so a
// /tmp default silently dropped registered scheduler/dispatcher roles after
// each restart. Default to an XDG_STATE_HOME-rooted path (which honors the env
// var when present and falls back to the standard user-level directory) so
// fresh checkouts persist by default.
export const DEFAULT_STATE_FILE_PATH = path.join(
  orchestratorPaths.stateDir,
  "orchestrator-state.json"
);

export const HUB_SOCKET_PATH = process.env.HUB_SOCKET_PATH ?? orchestratorPaths.hubSocketPath;
export const ROLES_SOCKET_PATH = process.env.ROLES_SOCKET_PATH
  ?? path.join(orchestratorPaths.socketDir, "orchestrator.sock");
export const GUI_PORT = Number(process.env.GUI_PORT ?? 7701);
export const GUI_LISTEN_HOST = normalizeOptionalEnvValue(process.env.GUI_LISTEN_HOST);
export const STATE_FILE_PATH = process.env.STATE_FILE_PATH ?? DEFAULT_STATE_FILE_PATH;
export const ROLES_SERVICE_ID = "service:meridian-roles";
export const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS ?? 2 * 60 * 1000);

export const IS_EPHEMERAL_STATE_FILE_PATH = isEphemeralFilesystemPath(STATE_FILE_PATH);
if (IS_EPHEMERAL_STATE_FILE_PATH) {
  console.warn(
    `[meridian-roles] STATE_FILE_PATH is on an ephemeral filesystem (${STATE_FILE_PATH}); ` +
      `registered scheduler/dispatcher roles will be lost on reboot. Point STATE_FILE_PATH at a ` +
      `persistent path such as "${DEFAULT_STATE_FILE_PATH}".`
  );
}

// Phase A6 kill-switch — when true, narrative-regex heuristics fall back when
// the structured MeridianStatusMarker is absent or rejected on the worker and
// validator channels. Defaults to true for backwards-compatibility; setting
// `MERIDIAN_FALLBACK_HEURISTICS_ENABLED=false` flips it off, in which case
// marker-absent worker runs return "running" (reconciler-retry) and validator
// runs return an error outcome rather than running JSON-fallback parsing.
// Note: PM-resolver envelope mapping is structured (not heuristic) and is
// never gated by this flag.
export const FALLBACK_HEURISTICS_ENABLED =
  (process.env.MERIDIAN_FALLBACK_HEURISTICS_ENABLED ?? "true").toLowerCase() !== "false";

// Kill-switch for automatic watchdog-driven bare parallel continuation. Read
// dynamically so an operator can change it without rebuilding the service.
// Defaults on because parallel_dispatch.enabled is already the plan-level
// opt-in; the breaker still guards repeated no-op continuations.
const DISPATCH_AUTO_PARALLEL_DISABLE_VALUES = new Set(["false", "0", "off", "no"]);
export function isDispatchAutoParallelEnabled(): boolean {
  const raw = (process.env.MERIDIAN_DISPATCH_AUTO_PARALLEL ?? "true").trim().toLowerCase();
  return !DISPATCH_AUTO_PARALLEL_DISABLE_VALUES.has(raw);
}

function loadEnvFiles(configDir: string): void {
  const explicitEnvKeys = new Set(Object.keys(process.env));
  const explicitEnvFile = normalizeOptionalEnvValue(process.env.MERIDIAN_ENV_FILE);
  const envFilePaths = explicitEnvFile
    ? [explicitEnvFile]
    : ENV_FILENAMES.map((fileName) => path.join(configDir, fileName));

  for (const envFilePath of envFilePaths) {
    if (!fs.existsSync(envFilePath)) {
      continue;
    }

    const raw = fs.readFileSync(envFilePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (!parsed || explicitEnvKeys.has(parsed.key)) {
        continue;
      }

      process.env[parsed.key] = parsed.value;
    }
  }
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const withoutExport = trimmed.startsWith("export ")
    ? trimmed.slice("export ".length).trim()
    : trimmed;
  const separatorIndex = withoutExport.indexOf("=");
  if (separatorIndex === -1) {
    return null;
  }

  const key = withoutExport.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }

  const rawValue = withoutExport.slice(separatorIndex + 1).trim();
  return {
    key,
    value: normalizeEnvValue(rawValue)
  };
}

function normalizeEnvValue(rawValue: string): string {
  if (
    rawValue.length >= 2
    && ((rawValue.startsWith("\"") && rawValue.endsWith("\"")) || (rawValue.startsWith("'") && rawValue.endsWith("'")))
  ) {
    return rawValue.slice(1, -1);
  }

  const commentIndex = rawValue.indexOf(" #");
  return commentIndex === -1 ? rawValue : rawValue.slice(0, commentIndex).trimEnd();
}

function normalizeOptionalEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isEphemeralFilesystemPath(filePath: string): boolean {
  const normalized = path.resolve(filePath);
  return /^\/(?:private\/)?(?:tmp|var\/tmp)(?:\/|$)/.test(normalized);
}
