import * as fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_STATE_FILE_PATH, STATE_FILE_PATH } from "./config";
import { normalizePersistedAppState } from "./roles/agent-dispatcher/config-normalization";
import { AppStateSchema, type AppState } from "./types";

type FileSystem = Pick<typeof fs, "mkdir" | "writeFile" | "rename" | "unlink" | "readFile">;
const WRITABLE_STATE_FILE_EXAMPLE = DEFAULT_STATE_FILE_PATH;

// Earlier releases shipped /tmp/meridian-roles/state.json as the writable
// example and as the path baked into local .env files. macOS purges /tmp on
// reboot, so any operator upgrading to a persistent STATE_FILE_PATH would
// otherwise see their registered roles vanish on the next service restart.
// load() transparently migrates this file forward exactly once.
export const LEGACY_EPHEMERAL_STATE_FILE_PATH = "/tmp/meridian-roles/state.json";
export const ACTIVE_ROLE_STATUS = "active";
export const PAUSED_ROLE_STATUS = "paused";
export const NEEDS_REACTIVATION_ROLE_STATUS = "needs_reactivation";
export const COMPLETED_ROLE_STATUS = "completed";
export const FAILED_ROLE_STATUS = "failed";

const REHYDRATABLE_ROLE_STATUSES = new Set([
  ACTIVE_ROLE_STATUS,
  PAUSED_ROLE_STATUS,
  NEEDS_REACTIVATION_ROLE_STATUS
]);

const RECONCILABLE_AGENT_DISPATCHER_ROLE_STATUSES = new Set([
  ...REHYDRATABLE_ROLE_STATUSES,
  COMPLETED_ROLE_STATUS,
  FAILED_ROLE_STATUS
]);

let tempFileCounter = 0;

export function isStartupRehydratableRoleStatus(status: string): boolean {
  return REHYDRATABLE_ROLE_STATUSES.has(status);
}

export function isReconcilableAgentDispatcherRoleStatus(status: string): boolean {
  return RECONCILABLE_AGENT_DISPATCHER_ROLE_STATUSES.has(status);
}

export function isTerminalAgentDispatcherRoleStatus(status: string): boolean {
  return status === COMPLETED_ROLE_STATUS || status === FAILED_ROLE_STATUS;
}

export class StateStore {
  constructor(
    private readonly filePath = STATE_FILE_PATH,
    private readonly fileSystem: FileSystem = fs,
    private readonly legacyEphemeralPath: string | null = LEGACY_EPHEMERAL_STATE_FILE_PATH
  ) {}

  async save(state: AppState): Promise<void> {
    const normalizedState = AppStateSchema.parse(state);
    const directory = path.dirname(this.filePath);
    const tempFilePath = createTempFilePath(this.filePath);
    const payload = `${JSON.stringify(normalizedState, null, 2)}\n`;

    try {
      await this.fileSystem.mkdir(directory, { recursive: true });
    } catch (error) {
      throw createStateStoreError("create state directory", directory, this.filePath, error);
    }

    try {
      await this.fileSystem.writeFile(tempFilePath, payload, "utf8");
    } catch (error) {
      await this.fileSystem.unlink(tempFilePath).catch(() => undefined);
      throw createStateStoreError("write temporary state file", tempFilePath, this.filePath, error);
    }

    try {
      await this.fileSystem.rename(tempFilePath, this.filePath);
    } catch (error) {
      await this.fileSystem.unlink(tempFilePath).catch(() => undefined);
      throw createStateStoreError("replace state file", this.filePath, this.filePath, error);
    }
  }

  async load(): Promise<AppState | null> {
    try {
      const raw = await this.fileSystem.readFile(this.filePath, "utf8");
      return normalizePersistedAppState(AppStateSchema.parse(JSON.parse(raw)));
    } catch (error) {
      if (isMissingFileError(error)) {
        return await this.loadAndMigrateFromLegacyPath();
      }

      throw error;
    }
  }

  private async loadAndMigrateFromLegacyPath(): Promise<AppState | null> {
    const legacyPath = this.legacyEphemeralPath;
    if (legacyPath === null) {
      return null;
    }
    if (path.resolve(this.filePath) === path.resolve(legacyPath)) {
      return null;
    }

    let raw: string;
    try {
      raw = await this.fileSystem.readFile(legacyPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }

    const state = normalizePersistedAppState(AppStateSchema.parse(JSON.parse(raw)));
    await this.save(state);

    const archivedLegacyPath = `${legacyPath}.migrated-${Date.now()}`;
    try {
      await this.fileSystem.rename(legacyPath, archivedLegacyPath);
    } catch {
      // Best-effort archival — leaving the legacy file in place is harmless
      // because the next load reads from this.filePath first and only falls
      // through to the legacy reader when the persistent file is missing.
    }

    console.warn(
      `[meridian-roles] Migrated ${state.roles.length} role(s) from legacy ephemeral state file ` +
        `"${legacyPath}" to "${this.filePath}". ` +
        `Original archived at "${archivedLegacyPath}".`
    );

    return state;
  }
}

function createTempFilePath(filePath: string): string {
  tempFileCounter = tempFileCounter >= Number.MAX_SAFE_INTEGER ? 1 : tempFileCounter + 1;
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);

  return path.join(directory, `.${basename}.${process.pid}.${Date.now()}.${tempFileCounter}.tmp`);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function createStateStoreError(
  action: string,
  attemptedPath: string,
  stateFilePath: string,
  error: unknown
): Error {
  const details = error instanceof Error ? error.message : String(error);
  return new Error(
    `Failed to ${action} at "${attemptedPath}" while saving state to "${stateFilePath}". ${details}. ` +
      `Set STATE_FILE_PATH to a writable absolute path, for example "${WRITABLE_STATE_FILE_EXAMPLE}".`,
    {
      cause: error
    }
  );
}
