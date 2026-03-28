import { readdirSync, type Dirent } from "node:fs";
import path from "node:path";

import { ToolRegistry, isToolDefinition } from "./registry";

const SUPPORTED_EXTENSIONS = new Set([".ts", ".js"]);

export async function loadToolsFromDirectory(toolsDir: string, registry: ToolRegistry): Promise<void> {
  let entries: Dirent<string>[];

  try {
    entries = readdirSync(toolsDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirectoryError(error)) {
      return;
    }
    throw error;
  }

  for (const entry of entries.filter((candidate) => candidate.isFile()).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!isSupportedToolFile(entry.name)) {
      continue;
    }

    const modulePath = path.resolve(toolsDir, entry.name);

    try {
      const loaded = loadModuleFresh(modulePath);
      const tool = extractToolDefinition(loaded);
      if (!isToolDefinition(tool)) {
        console.warn(`Skipping invalid tool module: ${modulePath}`);
        continue;
      }

      registry.register(tool);
    } catch (error) {
      console.warn(`Skipping tool module ${modulePath}: ${asError(error).message}`);
    }
  }
}

function loadModuleFresh(modulePath: string): unknown {
  const resolvedPath = require.resolve(modulePath);
  delete require.cache[resolvedPath];
  return require(resolvedPath) as unknown;
}

function extractToolDefinition(loaded: unknown): unknown {
  if (!loaded || typeof loaded !== "object") {
    return loaded;
  }

  return "default" in loaded ? (loaded as { default?: unknown }).default : loaded;
}

function isSupportedToolFile(fileName: string): boolean {
  if (fileName.endsWith(".d.ts")) {
    return false;
  }

  return SUPPORTED_EXTENSIONS.has(path.extname(fileName));
}

function isMissingDirectoryError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
