import * as fs from "node:fs/promises";
import path from "node:path";

import { STATE_FILE_PATH } from "./config";
import { AppStateSchema, type AppState } from "./types";

type FileSystem = Pick<typeof fs, "mkdir" | "writeFile" | "rename" | "unlink" | "readFile">;

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

    await this.fileSystem.mkdir(directory, { recursive: true });

    try {
      await this.fileSystem.writeFile(tempFilePath, payload, "utf8");
      await this.fileSystem.rename(tempFilePath, this.filePath);
    } catch (error) {
      await this.fileSystem.unlink(tempFilePath).catch(() => undefined);
      throw error;
    }
  }

  async load(): Promise<AppState | null> {
    try {
      const raw = await this.fileSystem.readFile(this.filePath, "utf8");
      return AppStateSchema.parse(JSON.parse(raw));
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
