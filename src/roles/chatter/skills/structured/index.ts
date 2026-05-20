import type { MemoryResolver } from "../../memory-resolver";
import { deleteStructuredRecord, type StructuredDeleteResult } from "./delete";
import { getStructuredRecord, type StructuredGetResult } from "./get";
import { listStructuredRecords, type StructuredListResult } from "./list";
import { queryStructuredRecords, type StructuredQueryResult } from "./query";
import { upsertStructuredRecord, type StructuredUpsertResult } from "./upsert";
import type { StructuredWhere } from "./index-file";

export { deleteStructuredRecord } from "./delete";
export { getStructuredRecord } from "./get";
export { listStructuredRecords } from "./list";
export { queryStructuredRecords } from "./query";
export { upsertStructuredRecord } from "./upsert";
export type { StructuredWhere, StructuredCondition, StructuredIndex } from "./index-file";
export type { StructuredError, StructuredErrorCode } from "./storage";

export const STRUCTURED_SKILL_NAMES = [
  "structured.upsert",
  "structured.get",
  "structured.query",
  "structured.delete",
  "structured.list"
] as const;

export type StructuredSkillName = typeof STRUCTURED_SKILL_NAMES[number];

export interface StructuredWriteEvent {
  name: "structured.write";
  type: string;
  key: string;
  record: unknown;
}

export interface StructuredSkillsOptions {
  onEvent?: (event: StructuredWriteEvent) => void | Promise<void>;
}

export interface StructuredSkills {
  upsert(type: string, key: string, record: unknown): Promise<StructuredUpsertResult>;
  get(type: string, key: string): Promise<StructuredGetResult>;
  query(type: string, where: StructuredWhere): Promise<StructuredQueryResult>;
  delete(type: string, key: string): Promise<StructuredDeleteResult>;
  list(type: string, filter?: StructuredWhere): Promise<StructuredListResult>;
}

export interface StructuredToolDescriptor {
  name: StructuredSkillName;
  description: string;
}

export interface StructuredSkillRegistry {
  register(name: StructuredSkillName, handler: (args: unknown) => Promise<unknown>): void;
}

export function makeStructuredSkills(
  resolver: MemoryResolver,
  options: StructuredSkillsOptions = {}
): StructuredSkills {
  const locks = new Map<string, Promise<void>>();

  async function withTypeLock<T>(type: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(type) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    locks.set(type, run.then(() => undefined, () => undefined));
    return run;
  }

  return {
    async upsert(type, key, record) {
      const result = await withTypeLock(type, () => upsertStructuredRecord(resolver, type, key, record));
      if (!isStructuredError(result)) {
        try {
          await options.onEvent?.({ name: "structured.write", type, key, record: result.record });
        } catch {
          // Event subscribers are downstream side effects; the validated write already succeeded.
        }
      }
      return result;
    },

    async get(type, key) {
      return getStructuredRecord(resolver, type, key);
    },

    async query(type, where) {
      return withTypeLock(type, () => queryStructuredRecords(resolver, type, where));
    },

    async delete(type, key) {
      return withTypeLock(type, () => deleteStructuredRecord(resolver, type, key));
    },

    async list(type, filter) {
      return withTypeLock(type, () => listStructuredRecords(resolver, type, filter));
    }
  };
}

export function getStructuredToolDescriptors(): StructuredToolDescriptor[] {
  return [
    { name: "structured.upsert", description: "Validate and upsert a structured record." },
    { name: "structured.get", description: "Read a structured record by type and key." },
    { name: "structured.query", description: "Query structured records by field conditions." },
    { name: "structured.delete", description: "Delete a structured record by type and key." },
    { name: "structured.list", description: "List structured record keys from the type index." }
  ];
}

export function registerStructuredSkills(
  skills: StructuredSkills,
  registry: StructuredSkillRegistry
): void {
  registry.register("structured.upsert", async (args) => {
    if (!isRecord(args) || typeof args.type !== "string" || typeof args.key !== "string") {
      return { error: "invalid_args", details: "expected { type, key, record }" };
    }
    return skills.upsert(args.type, args.key, args.record);
  });
  registry.register("structured.get", async (args) => {
    if (!isRecord(args) || typeof args.type !== "string" || typeof args.key !== "string") {
      return { error: "invalid_args", details: "expected { type, key }" };
    }
    return skills.get(args.type, args.key);
  });
  registry.register("structured.query", async (args) => {
    if (!isRecord(args) || typeof args.type !== "string") {
      return { error: "invalid_args", details: "expected { type, where }" };
    }
    return skills.query(args.type, args.where as StructuredWhere);
  });
  registry.register("structured.delete", async (args) => {
    if (!isRecord(args) || typeof args.type !== "string" || typeof args.key !== "string") {
      return { error: "invalid_args", details: "expected { type, key }" };
    }
    return skills.delete(args.type, args.key);
  });
  registry.register("structured.list", async (args) => {
    if (!isRecord(args) || typeof args.type !== "string") {
      return { error: "invalid_args", details: "expected { type, filter? }" };
    }
    return skills.list(args.type, args.filter as StructuredWhere | undefined);
  });
}

function isStructuredError(result: unknown): result is { error: string } {
  return isRecord(result) && typeof result.error === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
