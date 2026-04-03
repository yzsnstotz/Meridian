import * as fs from "node:fs";
import path from "node:path";

// meridian-roles runtime configuration
// All values overridable via environment variables — no hard-coded production paths

const ENV_LOCAL_FILENAME = ".env.local";

loadEnvLocal();

export const HUB_SOCKET_PATH = process.env.HUB_SOCKET_PATH ?? "/tmp/hub-socks/hub-core.sock";
export const ROLES_SOCKET_PATH = process.env.ROLES_SOCKET_PATH ?? "/tmp/meridian-roles.sock";
export const GUI_PORT = Number(process.env.GUI_PORT ?? 7701);
export const STATE_FILE_PATH = process.env.STATE_FILE_PATH ?? "/var/lib/meridian-roles/state.json";
export const ROLES_SERVICE_ID = "service:meridian-roles";

function loadEnvLocal(): void {
  const envFilePath = path.resolve(process.cwd(), ENV_LOCAL_FILENAME);
  if (!fs.existsSync(envFilePath)) {
    return;
  }

  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envFilePath);
    return;
  }

  const raw = fs.readFileSync(envFilePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed || Object.prototype.hasOwnProperty.call(process.env, parsed.key)) {
      continue;
    }

    process.env[parsed.key] = parsed.value;
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
