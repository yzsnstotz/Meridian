#!/usr/bin/env node

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ChatterManifestSchema, type ChatterManifest } from "../roles/chatter/manifest";
import { STRUCTURED_SKILL_NAMES } from "../roles/chatter/skills/structured";
import type { ProjectPolicyCliIo } from "./project-policy";

interface ValidationError {
  category: string;
  detail: string;
}

interface ValidationSummary {
  recordSchemas: number;
  seedFiles: number;
  systemPrompts: number;
  backgroundTriggers: number;
  readOnlyAllowlist: number;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const REGISTERED_READ_ONLY_SKILLS = new Set<string>(
  STRUCTURED_SKILL_NAMES.filter((name) => ["structured.get", "structured.list", "structured.query"].includes(name))
);

const defaultIo: ProjectPolicyCliIo = {
  stdout: process.stdout,
  stderr: process.stderr
};

export async function runValidateManifestCli(
  argv: string[],
  io: ProjectPolicyCliIo = defaultIo
): Promise<number> {
  const normalizedArgv = argv[0] === "validate-manifest" ? argv.slice(1) : argv;
  const [manifestPathArg, seedsPathArg, ...rest] = normalizedArgv;

  if (!manifestPathArg || rest.length > 0) {
    io.stderr.write("Usage: validate-manifest <absolute-path-to-manifest.json> [seeds-dir]\n");
    return 1;
  }

  const manifestPath = path.resolve(manifestPathArg);
  const result = validateManifestFile(manifestPath, seedsPathArg);
  if (result.errors.length > 0) {
    for (const error of result.errors) {
      io.stderr.write(`[ERROR] ${error.category}: ${error.detail}\n`);
    }
    return 1;
  }

  io.stdout.write(
    [
      "OK — manifest validated successfully",
      `record_schemas=${result.summary.recordSchemas}`,
      `seed_files=${result.summary.seedFiles}`,
      `system_prompts=${result.summary.systemPrompts}`,
      `background_triggers=${result.summary.backgroundTriggers}`,
      `read_only_allowlist=${result.summary.readOnlyAllowlist}`
    ].join(" ") + "\n"
  );
  return 0;
}

function validateManifestFile(
  manifestPath: string,
  seedsPathArg?: string
): { errors: ValidationError[]; summary: ValidationSummary } {
  const errors: ValidationError[] = [];
  const summary: ValidationSummary = {
    recordSchemas: 0,
    seedFiles: 0,
    systemPrompts: 0,
    backgroundTriggers: 0,
    readOnlyAllowlist: 0
  };

  const parsedJson = readJson(manifestPath);
  if (!parsedJson.ok) {
    return {
      errors: [{ category: "manifest", detail: `${manifestPath}: ${parsedJson.error}` }],
      summary
    };
  }

  const parsedManifest = ChatterManifestSchema.safeParse(parsedJson.value);
  if (!parsedManifest.success) {
    return {
      errors: parsedManifest.error.issues.map((issue) => ({
        category: "manifest",
        detail: `${manifestPath}: ${formatZodIssue(issue)}`
      })),
      summary
    };
  }

  const manifest = parsedManifest.data as ChatterManifest;
  const manifestDir = path.dirname(manifestPath);
  const compiledSchemas = validateRecordSchemas(manifest, errors);

  summary.recordSchemas = Object.keys(manifest.record_schemas ?? {}).length;
  summary.systemPrompts = Object.keys(manifest.system_prompts ?? {}).length;
  summary.backgroundTriggers = manifest.background_triggers?.length ?? 0;
  summary.readOnlyAllowlist = manifest.read_only_allowlist?.length ?? 0;
  summary.seedFiles = validateSeeds({
    manifest,
    manifestDir,
    seedsPathArg,
    compiledSchemas,
    errors
  });

  validateSystemPrompts(manifest, manifestDir, errors);
  validateBackgroundTriggers(manifest, compiledSchemas, errors);
  validateReadOnlyAllowlist(manifest, errors);

  return { errors, summary };
}

function validateRecordSchemas(
  manifest: ChatterManifest,
  errors: ValidationError[]
): Map<string, ValidateFunction> {
  const compiled = new Map<string, ValidateFunction>();

  for (const [recordType, schema] of Object.entries(manifest.record_schemas ?? {})) {
    const basePath = `record_schemas.${recordType}`;
    if (!isRecord(schema)) {
      errors.push({ category: "record_schemas", detail: `${basePath}: schema must be a JSON object` });
      continue;
    }
    if (typeof schema.type !== "string") {
      errors.push({ category: "record_schemas", detail: `${basePath}.type: schema must declare a top-level type` });
      continue;
    }
    if (hasCircularLocalRef(schema)) {
      errors.push({ category: "record_schemas", detail: `${basePath}: circular local $ref is not supported` });
      continue;
    }
    if (!ajv.validateSchema(schema)) {
      for (const error of ajv.errors ?? []) {
        errors.push({
          category: "record_schemas",
          detail: `${basePath}${jsonPointerToFieldPath(error.instancePath)}: ${formatAjvError(error)}`
        });
      }
      continue;
    }

    try {
      compiled.set(recordType, ajv.compile(schema));
    } catch (error) {
      errors.push({
        category: "record_schemas",
        detail: `${basePath}: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  return compiled;
}

function validateSeeds(options: {
  manifest: ChatterManifest;
  manifestDir: string;
  seedsPathArg?: string;
  compiledSchemas: ReadonlyMap<string, ValidateFunction>;
  errors: ValidationError[];
}): number {
  const seedsDir = resolveSeedsDir(options.manifest, options.manifestDir, options.seedsPathArg);
  if (!seedsDir) {
    return 0;
  }
  if (!existsSync(seedsDir)) {
    options.errors.push({ category: "seeds", detail: `${seedsDir}: seeds directory does not exist` });
    return 0;
  }

  const templatesDir = path.join(seedsDir, "templates");
  if (!existsSync(templatesDir)) {
    return 0;
  }

  let count = 0;
  for (const recordType of readdirSync(templatesDir)) {
    const recordTypeDir = path.join(templatesDir, recordType);
    if (!statSync(recordTypeDir).isDirectory()) {
      continue;
    }
    const seedSchema = resolveSeedRecordSchema(options.compiledSchemas, recordType);
    if (!seedSchema) {
      options.errors.push({
        category: "seeds",
        detail: `${recordTypeDir}: no record_schemas.${recordType} or record_schemas.template_${recordType} entry for seed type`
      });
      continue;
    }

    for (const fileName of readdirSync(recordTypeDir)) {
      if (!fileName.endsWith(".json")) {
        continue;
      }
      count += 1;
      const seedPath = path.join(recordTypeDir, fileName);
      const parsed = readJson(seedPath);
      if (!parsed.ok) {
        options.errors.push({ category: "seeds", detail: `${seedPath}: ${parsed.error}` });
        continue;
      }
      if (!seedSchema(parsed.value)) {
        for (const error of seedSchema.errors ?? []) {
          options.errors.push({
            category: "seeds",
            detail: `${seedPath}${error.instancePath || ""}: ${formatAjvError(error)}`
          });
        }
      }
    }
  }

  return count;
}

function resolveSeedRecordSchema(
  compiledSchemas: ReadonlyMap<string, ValidateFunction>,
  seedDirectoryName: string
): ValidateFunction | undefined {
  const exact = compiledSchemas.get(seedDirectoryName);
  if (exact) {
    return exact;
  }

  const templateRecordType = `template_${seedDirectoryName}`;
  const templateValidator = compiledSchemas.get(templateRecordType);
  if (templateValidator) {
    return templateValidator;
  }

  return undefined;
}

function validateSystemPrompts(manifest: ChatterManifest, manifestDir: string, errors: ValidationError[]): void {
  for (const [promptId, entry] of Object.entries(manifest.system_prompts ?? {})) {
    const promptPath = path.resolve(manifestDir, entry.prompt_path);
    try {
      readFileSync(promptPath, "utf8");
    } catch {
      errors.push({
        category: "system_prompts",
        detail: `system_prompts.${promptId}.prompt_path: ${entry.prompt_path} is not readable`
      });
    }
  }
}

function validateBackgroundTriggers(
  manifest: ChatterManifest,
  compiledSchemas: ReadonlyMap<string, ValidateFunction>,
  errors: ValidationError[]
): void {
  for (const [index, trigger] of (manifest.background_triggers ?? []).entries()) {
    if (!compiledSchemas.has(trigger.fires_on.record_type)) {
      errors.push({
        category: "background_triggers",
        detail: `background_triggers[${index}].fires_on.record_type: unknown record type '${trigger.fires_on.record_type}'`
      });
    }
    if (!manifest.system_prompts?.[trigger.action.system_prompt_id]) {
      errors.push({
        category: "background_triggers",
        detail: `background_triggers[${index}].action.system_prompt_id: unknown system prompt '${trigger.action.system_prompt_id}'`
      });
    }
  }
}

function validateReadOnlyAllowlist(manifest: ChatterManifest, errors: ValidationError[]): void {
  for (const [index, skillName] of (manifest.read_only_allowlist ?? []).entries()) {
    if (!REGISTERED_READ_ONLY_SKILLS.has(skillName)) {
      errors.push({
        category: "read_only_allowlist",
        detail: `read_only_allowlist[${index}]: unknown read-only skill '${skillName}'`
      });
    }
  }
}

function resolveSeedsDir(manifest: ChatterManifest, manifestDir: string, seedsPathArg?: string): string | undefined {
  if (seedsPathArg) {
    return path.resolve(seedsPathArg);
  }

  const raw = manifest.seeds_init?.source_path;
  if (!raw) {
    return undefined;
  }
  return path.isAbsolute(raw) ? raw : path.resolve(manifestDir, raw);
}

function readJson(filePath: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
  const pathText = issue.path.length > 0 ? issue.path.join(".") : "$";
  return `${pathText}: ${issue.message}`;
}

function formatAjvError(error: ErrorObject): string {
  const message = error.message ?? "invalid schema";
  return `${message} (${error.keyword})`;
}

function jsonPointerToFieldPath(pointer: string): string {
  if (pointer === "") {
    return "";
  }
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => `.${segment.replace(/~1/g, "/").replace(/~0/g, "~")}`)
    .join("");
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

if (require.main === module) {
  void runValidateManifestCli(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
