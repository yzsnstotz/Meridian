import type { ChatterManifest } from "../../manifest";
import type { MemoryResolver } from "../../memory-resolver";
import {
  fileExists,
  listStructuredRecordKeysOnDisk,
  readJsonFile,
  resolveStructuredIndexPath,
  resolveStructuredRecordPath,
  writeJsonFileAtomic
} from "./storage";

export interface StructuredIndex {
  keys: string[];
  by_field?: Record<string, Record<string, string[]>>;
}

export interface StructuredCondition {
  field: string;
  op: "eq" | "in";
  value: unknown;
}

export type StructuredWhere = StructuredCondition | { and: StructuredCondition[] };

export function readStructuredIndex(resolver: MemoryResolver, type: string): StructuredIndex {
  const indexPath = resolveStructuredIndexPath(resolver, type);
  if (!fileExists(indexPath)) {
    return { keys: [] };
  }
  const parsed = readJsonFile(indexPath);
  if (!isRecord(parsed) || !Array.isArray(parsed.keys)) {
    return { keys: [] };
  }
  const keys = parsed.keys.filter((key): key is string => typeof key === "string");
  const byField = isRecord(parsed.by_field) ? normalizeByField(parsed.by_field) : undefined;
  return byField ? { keys, by_field: byField } : { keys };
}

export function writeStructuredIndex(
  resolver: MemoryResolver,
  type: string,
  index: StructuredIndex
): void {
  writeJsonFileAtomic(resolveStructuredIndexPath(resolver, type), normalizeIndex(index));
}

export function getIndexedFields(manifest: ChatterManifest, type: string): string[] {
  const schema = manifest.record_schemas?.[type];
  if (!isRecord(schema)) {
    return [];
  }
  const fields = schema["x-indexed-fields"];
  if (!Array.isArray(fields)) {
    return [];
  }
  return [...new Set(fields.filter((field): field is string => typeof field === "string"))].sort();
}

export function readRecordsForKeys(
  resolver: MemoryResolver,
  type: string,
  keys: ReadonlyArray<string>
): Map<string, unknown> {
  const records = new Map<string, unknown>();
  for (const key of keys) {
    const recordPath = resolveStructuredRecordPath(resolver, type, key);
    if (fileExists(recordPath)) {
      records.set(key, readJsonFile(recordPath));
    }
  }
  return records;
}

export function rebuildStructuredIndex(
  keys: Iterable<string>,
  recordsByKey: ReadonlyMap<string, unknown>,
  indexedFields: ReadonlyArray<string>
): StructuredIndex {
  const normalizedKeys = [...new Set(keys)].sort();
  const byField: Record<string, Record<string, string[]>> = {};

  for (const field of indexedFields) {
    const fieldIndex: Record<string, string[]> = {};
    for (const key of normalizedKeys) {
      const record = recordsByKey.get(key);
      if (record === undefined) {
        continue;
      }
      for (const valueKey of indexValueKeys(getFieldValue(record, field))) {
        const bucket = fieldIndex[valueKey] ?? [];
        bucket.push(key);
        fieldIndex[valueKey] = bucket;
      }
    }
    for (const value of Object.keys(fieldIndex)) {
      fieldIndex[value] = [...new Set(fieldIndex[value])].sort();
    }
    byField[field] = fieldIndex;
  }

  return Object.keys(byField).length > 0
    ? { keys: normalizedKeys, by_field: byField }
    : { keys: normalizedKeys };
}

// Load the structured index reconciled against the record files actually on
// disk. `query`/`list` only ever return keys present in `_index.json`, so a
// record written straight to disk — e.g. by a coding-agent chatter that has
// filesystem access but no `structured.*` tool wired — would be invisible.
// When the on-disk record set drifts from the persisted index, rebuild the
// index from the files (and best-effort re-persist so the next read is fast).
// The structured store is thus self-healing for out-of-band writes.
export function loadReconciledStructuredIndex(
  resolver: MemoryResolver,
  type: string,
  indexedFields: ReadonlyArray<string>
): StructuredIndex {
  const persisted = readStructuredIndex(resolver, type);
  const diskKeys = listStructuredRecordKeysOnDisk(resolver, type);

  const persistedSet = new Set(persisted.keys);
  const sameKeySet =
    diskKeys.length === persisted.keys.length && diskKeys.every((key) => persistedSet.has(key));
  if (sameKeySet) {
    return persisted;
  }

  const recordsByKey = readRecordsForKeys(resolver, type, diskKeys);
  const rebuilt = rebuildStructuredIndex(diskKeys, recordsByKey, indexedFields);
  try {
    writeStructuredIndex(resolver, type, rebuilt);
  } catch {
    // Best-effort persist: an unwritable index still lets this call return
    // correct results; the next read just reconciles again.
  }
  return rebuilt;
}

export function normalizeWhere(where: unknown): StructuredCondition[] | null {
  if (isRecord(where) && Array.isArray(where.and)) {
    const conditions = where.and.map(normalizeCondition);
    return conditions.every((condition): condition is StructuredCondition => condition !== null)
      ? conditions
      : null;
  }
  const condition = normalizeCondition(where);
  return condition ? [condition] : null;
}

export function selectCandidateKeys(
  index: StructuredIndex,
  conditions: ReadonlyArray<StructuredCondition>,
  indexedFields: ReadonlyArray<string>
): string[] {
  const indexed = new Set(indexedFields);
  let candidates: Set<string> | null = null;

  for (const condition of conditions) {
    if (!indexed.has(condition.field)) {
      continue;
    }
    const matching = keysForIndexedCondition(index, condition);
    if (candidates === null) {
      candidates = new Set(matching);
      continue;
    }
    const intersected = new Set<string>();
    for (const key of candidates) {
      if (matching.has(key)) {
        intersected.add(key);
      }
    }
    candidates = intersected;
  }

  const keys = candidates === null ? index.keys : [...candidates];
  return index.keys.filter((key) => keys.includes(key));
}

export function recordMatchesConditions(
  record: unknown,
  conditions: ReadonlyArray<StructuredCondition>
): boolean {
  return conditions.every((condition) => recordMatchesCondition(record, condition));
}

function normalizeIndex(index: StructuredIndex): StructuredIndex {
  const keys = [...new Set(index.keys)].sort();
  if (!index.by_field) {
    return { keys };
  }
  return { keys, by_field: normalizeByField(index.by_field) };
}

function normalizeByField(input: Record<string, unknown>): Record<string, Record<string, string[]>> {
  const normalized: Record<string, Record<string, string[]>> = {};
  for (const [field, values] of Object.entries(input)) {
    if (!isRecord(values)) {
      continue;
    }
    normalized[field] = {};
    for (const [value, keys] of Object.entries(values)) {
      if (Array.isArray(keys)) {
        normalized[field][value] = [...new Set(keys.filter(
          (key): key is string => typeof key === "string"
        ))].sort();
      }
    }
  }
  return normalized;
}

function normalizeCondition(input: unknown): StructuredCondition | null {
  if (!isRecord(input)) {
    return null;
  }
  if (typeof input.field !== "string") {
    return null;
  }
  if (input.op !== "eq" && input.op !== "in") {
    return null;
  }
  if (input.op === "in" && !Array.isArray(input.value)) {
    return null;
  }
  return { field: input.field, op: input.op, value: input.value };
}

function keysForIndexedCondition(
  index: StructuredIndex,
  condition: StructuredCondition
): Set<string> {
  const fieldIndex = index.by_field?.[condition.field] ?? {};
  const values = condition.op === "in" && Array.isArray(condition.value)
    ? condition.value
    : [condition.value];
  const keys = new Set<string>();
  for (const value of values) {
    for (const key of fieldIndex[indexValueKey(value)] ?? []) {
      keys.add(key);
    }
  }
  return keys;
}

function recordMatchesCondition(record: unknown, condition: StructuredCondition): boolean {
  const fieldValue = getFieldValue(record, condition.field);
  if (condition.op === "eq") {
    return valueMatches(fieldValue, condition.value);
  }
  if (!Array.isArray(condition.value)) {
    return false;
  }
  return condition.value.some((candidate) => valueMatches(fieldValue, candidate));
}

function valueMatches(fieldValue: unknown, expected: unknown): boolean {
  if (Array.isArray(fieldValue)) {
    return fieldValue.some((item) => indexValueKey(item) === indexValueKey(expected));
  }
  return indexValueKey(fieldValue) === indexValueKey(expected);
}

function getFieldValue(record: unknown, field: string): unknown {
  let current = record;
  for (const segment of field.split(".")) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function indexValueKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(indexValueKeys);
  }
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return [indexValueKey(value)];
  }
  return [];
}

function indexValueKey(value: unknown): string {
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
