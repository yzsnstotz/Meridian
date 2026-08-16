import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ENV_FILES = [".env", ".env.local"];
export const INTERNAL_BOOTSTRAP_KEY = "MERIDIAN_INTERNAL_BOOTSTRAP_KEY";
export const WEB_GUI_TOKEN = "WEB_GUI_TOKEN";

/**
 * Loads Meridian user configuration without overriding values explicitly
 * supplied by the caller. The supervisor needs the same endpoint and auth
 * values as its children in order to perform real readiness probes.
 */
export function loadSupervisorEnvironment(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const explicit = new Set(Object.keys(env));
  for (const fileName of ENV_FILES) {
    const filePath = path.join(configDir, fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const parsed = parseLine(line);
      if (parsed && !explicit.has(parsed.key)) {
        env[parsed.key] = parsed.value;
      }
    }
  }
  return env;
}

export function ensureSharedBootstrapKey(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return ensurePrivateSecret(configDir, env, INTERNAL_BOOTSTRAP_KEY);
}

export function ensureWebGuiToken(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return ensurePrivateSecret(configDir, env, WEB_GUI_TOKEN);
}

function ensurePrivateSecret(
  configDir: string,
  env: NodeJS.ProcessEnv,
  key: typeof INTERNAL_BOOTSTRAP_KEY | typeof WEB_GUI_TOKEN
): string {
  const existing = env[key]?.trim();
  if (existing) {
    return existing;
  }
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const value = crypto.randomBytes(32).toString("hex");
  const envPath = path.join(configDir, ".env");
  fs.appendFileSync(envPath, `\n${key}=${value}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  if (process.platform !== "win32") {
    fs.chmodSync(envPath, 0o600);
  }
  env[key] = value;
  return value;
}

function parseLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  const source = trimmed.startsWith("export ")
    ? trimmed.slice("export ".length).trim()
    : trimmed;
  const separator = source.indexOf("=");
  if (separator < 1) {
    return null;
  }
  const key = source.slice(0, separator).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }
  let value = source.slice(separator + 1).trim();
  if (
    value.length >= 2
    && ((value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}
