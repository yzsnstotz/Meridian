import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { MemoryResolver } from "./memory-resolver";

export type MemoryMode = "stateless" | "session";

export interface MemoryToolResult {
  ok: boolean;
  content?: string;
  entries?: ReadonlyArray<string>;
  error?: string;
}

export interface MemoryReadArgs {
  binding: string;
  vars: Record<string, string>;
}

export interface MemoryWriteArgs extends MemoryReadArgs {
  content: string;
}

export interface MemorySkills {
  read(args: MemoryReadArgs): Promise<MemoryToolResult>;
  write(args: MemoryWriteArgs): Promise<MemoryToolResult>;
  list(args: MemoryReadArgs): Promise<MemoryToolResult>;
}

function errString(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function makeMemorySkills(resolver: MemoryResolver, mode: MemoryMode): MemorySkills {
  // Per-key write serialization. Multiple concurrent writes to the same
  // resolved path are chained so the final file contains exactly one
  // writer's content end-to-end.
  const writeLocks = new Map<string, Promise<void>>();

  return {
    async read(args) {
      let resolved: string;
      try {
        resolved = resolver.resolveBinding(args.binding, args.vars);
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
      if (!existsSync(resolved)) {
        return { ok: false, error: "not_found" };
      }
      try {
        return { ok: true, content: readFileSync(resolved, "utf8") };
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },

    async write(args) {
      if (mode === "stateless") {
        return { ok: false, error: "read_only_mode" };
      }
      let resolved: string;
      try {
        resolved = resolver.resolveBinding(args.binding, args.vars);
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
      const previous = writeLocks.get(resolved) ?? Promise.resolve();
      const next = previous.then(() => {
        mkdirSync(path.dirname(resolved), { recursive: true });
        writeFileSync(resolved, args.content);
      });
      writeLocks.set(resolved, next.catch(() => undefined));
      try {
        await next;
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },

    async list(args) {
      let resolved: string;
      try {
        resolved = resolver.resolveBinding(args.binding, args.vars);
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
      const dir = path.dirname(resolved);
      if (!existsSync(dir)) {
        return { ok: true, entries: [] };
      }
      try {
        return { ok: true, entries: readdirSync(dir) };
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    }
  };
}
