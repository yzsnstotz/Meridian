import * as fs from "node:fs/promises";
import path from "node:path";

export interface MonitorFileStat {
  size: number;
  mtimeMs: number;
}

export interface MonitorFsStat {
  freeBytes: number;
}

export async function statFileSafe(filePath: string): Promise<MonitorFileStat | null> {
  try {
    const stat = await fs.stat(filePath);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

export async function statFilesystemFree(filePath: string): Promise<MonitorFsStat> {
  const candidate = path.dirname(filePath);
  try {
    return await statFilesystemPath(candidate);
  } catch {
    return await statFilesystemPath("/");
  }
}

async function statFilesystemPath(filePath: string): Promise<MonitorFsStat> {
  const stat = await fs.statfs(filePath);
  return { freeBytes: Number(stat.bavail) * Number(stat.bsize) };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
