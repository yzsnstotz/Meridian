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
import { DeniedReadOnlyRootError, MemoryResolver, SandboxViolationError } from "../../memory-resolver";
import { incrementChatterSandboxRootWriteDeniedTotal } from "../../observability";

export type StructuredErrorCode =
  | "schema_violation"
  | "sandbox_violation"
  | "denied_ro_root"
  | "not_found"
  | "unknown_type"
  | "invalid_where"
  | "invalid_args"
  | "io_error";

export interface StructuredError {
  error: StructuredErrorCode;
  details?: unknown;
  attempted_path?: string;
}

export function resolveStructuredRecordPath(
  resolver: MemoryResolver,
  type: string,
  key: string
): string {
  return resolveStructuredRecordReadPath(resolver, type, key);
}

export function resolveStructuredRecordReadPath(
  resolver: MemoryResolver,
  type: string,
  key: string
): string {
  return resolver.resolveMemoryPathForRead("structured", type, `${key}.json`);
}

export function resolveStructuredRecordWritePath(
  resolver: MemoryResolver,
  type: string,
  key: string
): string {
  return resolver.resolveMemoryPathForWrite("structured", type, `${key}.json`);
}

export function resolveStructuredIndexPath(resolver: MemoryResolver, type: string): string {
  return resolveStructuredIndexReadPath(resolver, type);
}

export function resolveStructuredIndexReadPath(resolver: MemoryResolver, type: string): string {
  return resolver.resolveMemoryPathForRead("structured", type, "_index.json");
}

export function resolveStructuredIndexWritePath(resolver: MemoryResolver, type: string): string {
  return resolver.resolveMemoryPathForWriteAllowingReadOnlyShadow("structured", type, "_index.json");
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
  const keys = new Set<string>();
  for (const typeDir of resolver.resolveMemoryPathCandidatesForRead("structured", type)) {
    if (!existsSync(typeDir)) {
      continue;
    }
    for (const name of readdirSync(typeDir)) {
      if (name.endsWith(".json") && name !== "_index.json") {
        keys.add(name.slice(0, -".json".length));
      }
    }
  }
  return [...keys].sort();
}

export function structuredErrorFromUnknown(error: unknown): StructuredError {
  if (error instanceof DeniedReadOnlyRootError) {
    incrementChatterSandboxRootWriteDeniedTotal("ro");
    return { error: "denied_ro_root", attempted_path: error.attemptedPath };
  }
  if (error instanceof SandboxViolationError) {
    return { error: "sandbox_violation", details: error.message };
  }
  return { error: "io_error", details: error instanceof Error ? error.message : String(error) };
}

export function unknownType(type: string): StructuredError {
  return { error: "unknown_type", details: `unknown record type: ${type}` };
}
