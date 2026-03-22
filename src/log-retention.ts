import fs from "node:fs";
import path from "node:path";

export interface LogInventoryEntry {
  path: string;
  size_bytes: number;
  updated_at: string;
}

export interface LogInventory {
  root: string;
  total_bytes: number;
  files: LogInventoryEntry[];
  generated_at: string;
}

export interface LogRetentionLogger {
  info: (bindings: Record<string, unknown>, message: string) => void;
  warn: (bindings: Record<string, unknown>, message: string) => void;
}

export interface LogRetentionOptions {
  logDir: string;
  activeFileMaxBytes: number;
  activeFileKeepBytes: number;
  sessionFileMaxBytes: number;
  sessionFileKeepBytes: number;
  sessionFileMaxAgeHours: number;
  now?: () => Date;
}

export interface LogRetentionWorkerOptions extends LogRetentionOptions {
  enabled: boolean;
  intervalMs: number;
  logger: LogRetentionLogger;
}

interface ClassifiedLogFile extends LogInventoryEntry {
  absolute_path: string;
  category: "active" | "session" | "other";
}

export interface LogRetentionResult {
  removed: string[];
  trimmed: string[];
}

const ACTIVE_LOG_NAMES = new Set([
  "hub.log",
  "hub-error.log",
  "interface.log",
  "interface-error.log",
  "instance.log",
  "monitor.log",
  "monitor-error.log",
  "web.log",
  "web-error.log"
]);

function classifyLogPath(relativePath: string): "active" | "session" | "other" {
  const basename = path.basename(relativePath);
  if (ACTIVE_LOG_NAMES.has(basename)) {
    return "active";
  }
  if (
    basename.startsWith("pane-") ||
    basename.startsWith("agentapi-") ||
    basename.startsWith("gui-pane-") ||
    basename.endsWith("-stdout.log")
  ) {
    return "session";
  }
  return "other";
}

async function listLogFilesRecursive(rootDir: string, currentDir: string, entries: ClassifiedLogFile[]): Promise<void> {
  const dirEntries = await fs.promises.readdir(currentDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });

  for (const dirEntry of dirEntries) {
    const absolutePath = path.join(currentDir, dirEntry.name);
    if (dirEntry.isDirectory()) {
      await listLogFilesRecursive(rootDir, absolutePath, entries);
      continue;
    }
    if (!dirEntry.isFile() || !dirEntry.name.endsWith(".log")) {
      continue;
    }
    const stats = await fs.promises.stat(absolutePath);
    const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join("/");
    entries.push({
      absolute_path: absolutePath,
      path: relativePath,
      size_bytes: stats.size,
      updated_at: stats.mtime.toISOString(),
      category: classifyLogPath(relativePath)
    });
  }
}

export async function collectLogInventory(logDir: string, now: Date = new Date()): Promise<LogInventory> {
  const files: ClassifiedLogFile[] = [];
  await listLogFilesRecursive(logDir, logDir, files);
  files.sort((left, right) => right.size_bytes - left.size_bytes || left.path.localeCompare(right.path));

  return {
    root: logDir,
    total_bytes: files.reduce((sum, entry) => sum + entry.size_bytes, 0),
    files: files.map(({ absolute_path: _absolutePath, category: _category, ...entry }) => entry),
    generated_at: now.toISOString()
  };
}

async function trimFileToTailBytes(filePath: string, keepBytes: number): Promise<void> {
  const handle = await fs.promises.open(filePath, "r+");
  try {
    const stats = await handle.stat();
    const bytesToRead = Math.min(stats.size, keepBytes);
    if (bytesToRead <= 0) {
      await handle.truncate(0);
      return;
    }

    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, stats.size - bytesToRead);

    let finalBuffer = buffer;
    const newlineIndex = buffer.indexOf(0x0a);
    if (newlineIndex >= 0 && newlineIndex < buffer.length - 1) {
      finalBuffer = buffer.subarray(newlineIndex + 1);
    }

    await handle.truncate(0);
    await handle.writeFile(finalBuffer);
  } finally {
    await handle.close();
  }
}

export async function enforceLogRetention(options: LogRetentionOptions): Promise<LogRetentionResult> {
  const now = options.now?.() ?? new Date();
  const files: ClassifiedLogFile[] = [];
  await listLogFilesRecursive(options.logDir, options.logDir, files);

  const result: LogRetentionResult = { removed: [], trimmed: [] };
  const sessionMaxAgeMs = options.sessionFileMaxAgeHours * 60 * 60 * 1000;

  for (const entry of files) {
    if (entry.category === "active" && entry.size_bytes > options.activeFileMaxBytes) {
      await trimFileToTailBytes(entry.absolute_path, options.activeFileKeepBytes);
      result.trimmed.push(entry.path);
      continue;
    }

    if (entry.category !== "session") {
      continue;
    }

    const ageMs = Math.max(0, now.getTime() - new Date(entry.updated_at).getTime());
    if (ageMs > sessionMaxAgeMs) {
      await fs.promises.unlink(entry.absolute_path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
      result.removed.push(entry.path);
      continue;
    }

    if (entry.size_bytes > options.sessionFileMaxBytes) {
      await trimFileToTailBytes(entry.absolute_path, options.sessionFileKeepBytes);
      result.trimmed.push(entry.path);
    }
  }

  return result;
}

export function startLogRetentionWorker(options: LogRetentionWorkerOptions): { stop: () => void } {
  if (!options.enabled) {
    return { stop: () => undefined };
  }

  let stopped = false;
  const runPass = async (): Promise<void> => {
    try {
      const result = await enforceLogRetention(options);
      if (result.removed.length === 0 && result.trimmed.length === 0) {
        return;
      }
      options.logger.info(
        {
          trace_id: null,
          thread_id: null,
          log_dir: options.logDir,
          removed: result.removed,
          trimmed: result.trimmed
        },
        "Applied log retention policy"
      );
    } catch (error) {
      options.logger.warn(
        {
          trace_id: null,
          thread_id: null,
          log_dir: options.logDir,
          err: error instanceof Error ? error.message : String(error)
        },
        "Log retention pass failed"
      );
    }
  };

  void runPass();
  const timer = setInterval(() => {
    if (!stopped) {
      void runPass();
    }
  }, options.intervalMs);
  timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    }
  };
}
