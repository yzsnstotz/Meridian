import * as fs from "node:fs";
import path from "node:path";

// meridian-roles runtime configuration
// All values overridable via environment variables — no hard-coded production paths

const ENV_FILENAMES = [".env", ".env.local", ".meridian_n02/.env"];

loadEnvFiles();

export const HUB_SOCKET_PATH = process.env.HUB_SOCKET_PATH ?? "/tmp/hub-socks/hub-core.sock";
export const ROLES_SOCKET_PATH = process.env.ROLES_SOCKET_PATH ?? "/tmp/meridian-roles.sock";
export const GUI_PORT = Number(process.env.GUI_PORT ?? 7701);
export const GUI_LISTEN_HOST = normalizeOptionalEnvValue(process.env.GUI_LISTEN_HOST);
export const STATE_FILE_PATH = process.env.STATE_FILE_PATH ?? "/var/lib/meridian-roles/state.json";
export const ROLES_SERVICE_ID = "service:meridian-roles";
export const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS ?? 2 * 60 * 1000);

function loadEnvFiles(): void {
  const explicitEnvKeys = new Set(Object.keys(process.env));

  for (const fileName of ENV_FILENAMES) {
    const envFilePath = path.resolve(process.cwd(), fileName);
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
