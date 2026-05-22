import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { MemoryResolver, SandboxViolationError } from "../../memory-resolver";

export type StructuredErrorCode =
  | "schema_violation"
  | "sandbox_violation"
  | "not_found"
  | "unknown_type"
  | "invalid_where"
  | "invalid_args"
  | "io_error";

export interface StructuredError {
  error: StructuredErrorCode;
  details?: unknown;
}

export function resolveStructuredRecordPath(
  resolver: MemoryResolver,
  type: string,
  key: string
): string {
  return resolver.resolveMemoryPath("structured", type, `${key}.json`);
}

export function resolveStructuredIndexPath(resolver: MemoryResolver, type: string): string {
  return resolver.resolveMemoryPath("structured", type, "_index.json");
}

export function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmpPath, filePath);
}

export function removeFileIfExists(filePath: string): boolean {
  if (!existsSync(filePath)) {
    return false;
  }
  rmSync(filePath);
  return true;
}

export function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

// Record keys actually present on disk under `structured/<type>/`, derived
// from the `<key>.json` files (the `_index.json` sidecar is excluded). This
// is the ground truth — used to reconcile a possibly-stale `_index.json`.
export function listStructuredRecordKeysOnDisk(resolver: MemoryResolver, type: string): string[] {
  const typeDir = path.dirname(resolveStructuredIndexPath(resolver, type));
  if (!existsSync(typeDir)) {
    return [];
  }
  return readdirSync(typeDir)
    .filter((name) => name.endsWith(".json") && name !== "_index.json")
    .map((name) => name.slice(0, -".json".length));
}

export function structuredErrorFromUnknown(error: unknown): StructuredError {
  if (error instanceof SandboxViolationError) {
    return { error: "sandbox_violation", details: error.message };
  }
  return { error: "io_error", details: error instanceof Error ? error.message : String(error) };
}

export function unknownType(type: string): StructuredError {
  return { error: "unknown_type", details: `unknown record type: ${type}` };
}
