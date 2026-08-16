import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveMeridianPaths } from "@meridian/contracts";

import { normalizePersistedAppState } from "../roles/agent-dispatcher/config-normalization";
import { AppStateSchema, type AppState } from "../types";

export interface LegacyStateDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export interface RolesStateImportOptions {
  sourcePath: string;
  targetPath?: string;
  dryRun?: boolean;
}

export interface RolesStateImportResult {
  ok: true;
  status: "planned" | "imported" | "already_imported";
  sourcePath: string;
  targetPath: string;
  roles: number;
  sourcePreserved: true;
}

export function discoverExistingRolesStatePaths(
  options: LegacyStateDiscoveryOptions = {}
): string[] {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.HOME;
  if (!homeDir || !path.isAbsolute(homeDir)) {
    throw new Error("an absolute home directory is required for legacy state discovery");
  }
  const platform = options.platform ?? process.platform;
  const candidates = [
    env.STATE_FILE_PATH,
    env.MERIDIAN_ROLES_STATE_PATH,
    path.join(homeDir, ".meridian-roles", "state.json"),
    path.join(homeDir, ".local", "state", "meridian-roles", "state.json"),
    ...(platform === "darwin"
      ? [path.join(homeDir, "Library", "Application Support", "Meridian Roles", "state.json")]
      : []),
    "/tmp/meridian-roles/state.json"
  ];
  return Array.from(new Set(candidates.filter(
    (candidate): candidate is string =>
      typeof candidate === "string"
      && path.isAbsolute(candidate)
      && fs.existsSync(candidate)
  )));
}

export function importRolesState(options: RolesStateImportOptions): RolesStateImportResult {
  const sourcePath = requireAbsolute(options.sourcePath, "sourcePath");
  const targetPath = requireAbsolute(
    options.targetPath
      ?? path.join(resolveMeridianPaths().stateDir, "orchestrator-state.json"),
    "targetPath"
  );
  if (sourcePath === targetPath) {
    throw new Error("source and target state paths must be different");
  }

  const sourceState = readValidatedState(sourcePath);
  const resultBase = {
    ok: true as const,
    sourcePath,
    targetPath,
    roles: sourceState.roles.length,
    sourcePreserved: true as const
  };
  if (fs.existsSync(targetPath)) {
    const targetState = readValidatedState(targetPath);
    if (!statesEqual(sourceState, targetState)) {
      throw new Error(
        `target state already exists with different content: ${targetPath}; refusing to overwrite`
      );
    }
    return { ...resultBase, status: "already_imported" };
  }
  if (options.dryRun) {
    return { ...resultBase, status: "planned" };
  }

  const payload = Buffer.from(`${JSON.stringify(sourceState, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    fs.chmodSync(path.dirname(targetPath), 0o700);
  }
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, payload, { mode: 0o600 });
  fs.renameSync(temporaryPath, targetPath);
  if (process.platform !== "win32") {
    fs.chmodSync(targetPath, 0o600);
  }
  return { ...resultBase, status: "imported" };
}

function readValidatedState(filePath: string): AppState {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  return normalizePersistedAppState(AppStateSchema.parse(parsed));
}

function statesEqual(left: AppState, right: AppState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireAbsolute(value: string, label: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.normalize(value);
}
