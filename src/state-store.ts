import * as fs from "node:fs/promises";
import path from "node:path";

import { STATE_FILE_PATH } from "./config";
import { normalizePersistedAppState } from "./roles/agent-dispatcher/config-normalization";
import { AppStateSchema, type AppState } from "./types";

type FileSystem = Pick<typeof fs, "mkdir" | "writeFile" | "rename" | "unlink" | "readFile">;
const WRITABLE_STATE_FILE_EXAMPLE = "/tmp/meridian-roles/state.json";
export const ACTIVE_ROLE_STATUS = "active";
export const PAUSED_ROLE_STATUS = "paused";
export const NEEDS_REACTIVATION_ROLE_STATUS = "needs_reactivation";

export function isStartupRehydratableRoleStatus(status: string): boolean {
  return status === ACTIVE_ROLE_STATUS || status === PAUSED_ROLE_STATUS || status === NEEDS_REACTIVATION_ROLE_STATUS;
}

export class StateStore {
  constructor(
    private readonly filePath = STATE_FILE_PATH,
    private readonly fileSystem: FileSystem = fs
  ) {}

  async save(state: AppState): Promise<void> {
    const normalizedState = AppStateSchema.parse(state);
    const directory = path.dirname(this.filePath);
    const tempFilePath = `${this.filePath}.tmp`;
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
        return null;
      }

      throw error;
    }
  }
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
