import { z } from "zod";
import { readFileSync } from "node:fs";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import type { ChatterTemplateName } from "../../types";
import {
  FLAT_LOG_MANIFEST,
  TOPIC_TREE_MANIFEST,
  INDEXED_KB_MANIFEST
} from "./templates";

const ajv = new Ajv2020({ allErrors: true, strict: false });

export class InvalidRecordSchemaError extends Error {
  constructor(
    public readonly recordType: string,
    cause: unknown
  ) {
    super(`Invalid record schema for ${recordType}: ${formatSchemaError(cause)}`);
    this.name = "InvalidRecordSchemaError";
  }
}

export const ChatterManifestSchema = z
  .object({
    version: z.literal(1),
    layers: z.enum(["flat", "tree"]),
    index: z.enum(["none", "json"]),
    bindings: z.record(z.string().min(1), z.string().min(1)),
    record_schemas: z.record(z.string().min(1), z.unknown()).optional()
  })
  .strict();

export type ChatterManifest = z.infer<typeof ChatterManifestSchema> & {
  readonly compiledRecordSchemas?: ReadonlyMap<string, ValidateFunction>;
};

export type RecordValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; errors: ErrorObject[] };

export function loadManifestFromTemplate(name: ChatterTemplateName): ChatterManifest {
  switch (name) {
    case "flat-log":
      return parseManifest(FLAT_LOG_MANIFEST);
    case "topic-tree":
      return parseManifest(TOPIC_TREE_MANIFEST);
    case "indexed-kb":
      return parseManifest(INDEXED_KB_MANIFEST);
  }
}

export function loadManifestFromFile(absPath: string): ChatterManifest {
  const raw = readFileSync(absPath, "utf8");
  const json = JSON.parse(raw);
  return parseManifest(json);
}

export function hasRecordType(manifest: ChatterManifest, type: string): boolean {
  return Boolean(manifest.compiledRecordSchemas?.has(type));
}

export function validateRecord(
  manifest: ChatterManifest,
  type: string,
  record: unknown
): RecordValidationResult {
  const validator = manifest.compiledRecordSchemas?.get(type);
  if (!validator) {
    return {
      ok: false,
      errors: [{
        instancePath: "",
        schemaPath: "#",
        keyword: "record_type",
        params: { type },
        message: `unknown record type: ${type}`
      }]
    };
  }

  if (validator(record)) {
    return { ok: true, value: record };
  }

  return { ok: false, errors: validator.errors ?? [] };
}

function parseManifest(input: unknown): ChatterManifest {
  const manifest = ChatterManifestSchema.parse(input) as ChatterManifest;
  const compiledRecordSchemas = compileRecordSchemas(manifest.record_schemas);
  if (compiledRecordSchemas.size === 0) {
    return manifest;
  }

  Object.defineProperty(manifest, "compiledRecordSchemas", {
    value: compiledRecordSchemas,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return manifest;
}

function compileRecordSchemas(recordSchemas: ChatterManifest["record_schemas"]): ReadonlyMap<string, ValidateFunction> {
  const compiled = new Map<string, ValidateFunction>();
  for (const [type, schema] of Object.entries(recordSchemas ?? {})) {
    try {
      assertRecordSchemaShape(schema);
      compiled.set(type, ajv.compile(schema));
    } catch (error) {
      throw new InvalidRecordSchemaError(type, error);
    }
  }
  return compiled;
}

function assertRecordSchemaShape(schema: unknown): asserts schema is object {
  if (!isRecord(schema)) {
    throw new Error("schema must be a JSON object");
  }
  if (typeof schema.type !== "string") {
    throw new Error("schema must declare a top-level type");
  }
  if (hasCircularLocalRef(schema)) {
    throw new Error("circular local $ref is not supported");
  }
}

function hasCircularLocalRef(schema: unknown): boolean {
  const graph = new Map<string, string[]>();
  collectSchemaGraph(schema, "", graph);
  return graphHasCycle("", graph, new Set(), new Set());
}

function collectSchemaGraph(value: unknown, pointer: string, graph: Map<string, string[]>): void {
  if (!isRecord(value)) {
    return;
  }

  const edges = graph.get(pointer) ?? [];
  graph.set(pointer, edges);

  const ref = value.$ref;
  if (typeof ref === "string" && ref.startsWith("#")) {
    edges.push(decodeLocalRef(ref));
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref") {
      continue;
    }
    const childPointer = `${pointer}/${escapeJsonPointerSegment(key)}`;
    if (Array.isArray(child)) {
      for (const [index, item] of child.entries()) {
        if (isRecord(item)) {
          const itemPointer = `${childPointer}/${index}`;
          edges.push(itemPointer);
          collectSchemaGraph(item, itemPointer, graph);
        }
      }
      continue;
    }
    if (isRecord(child)) {
      edges.push(childPointer);
      collectSchemaGraph(child, childPointer, graph);
    }
  }
}

function graphHasCycle(
  pointer: string,
  graph: ReadonlyMap<string, readonly string[]>,
  visiting: Set<string>,
  visited: Set<string>
): boolean {
  if (!graph.has(pointer)) {
    return false;
  }
  if (visiting.has(pointer)) {
    return true;
  }
  if (visited.has(pointer)) {
    return false;
  }

  visiting.add(pointer);
  for (const next of graph.get(pointer) ?? []) {
    if (graphHasCycle(next, graph, visiting, visited)) {
      return true;
    }
  }
  visiting.delete(pointer);
  visited.add(pointer);
  return false;
}

function decodeLocalRef(ref: string): string {
  if (ref === "#") {
    return "";
  }
  if (!ref.startsWith("#/")) {
    return ref;
  }
  return ref
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .join("/");
}

function escapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatSchemaError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
