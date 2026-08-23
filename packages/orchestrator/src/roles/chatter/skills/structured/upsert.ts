import type { MemoryResolver } from "../../memory-resolver";
import { validateRecord } from "../../manifest";
import {
  getIndexedFields,
  readRecordsForKeys,
  readStructuredIndex,
  rebuildStructuredIndex,
  writeStructuredIndex
} from "./index-file";
import {
  resolveStructuredRecordWritePath,
  structuredErrorFromUnknown,
  type StructuredError,
  writeJsonFileAtomic
} from "./storage";

export type StructuredUpsertResult = { record: unknown } | StructuredError;

export async function upsertStructuredRecord(
  resolver: MemoryResolver,
  type: string,
  key: string,
  record: unknown
): Promise<StructuredUpsertResult> {
  const validation = validateRecord(resolver.manifest, type, record);
  if (!validation.ok) {
    return { error: "schema_violation", details: validation.errors };
  }

  try {
    const recordPath = resolveStructuredRecordWritePath(resolver, type, key);
    const index = readStructuredIndex(resolver, type);
    const records = readRecordsForKeys(resolver, type, index.keys.filter((existing) => existing !== key));
    records.set(key, validation.value);
    const nextIndex = rebuildStructuredIndex(
      [...index.keys, key],
      records,
      getIndexedFields(resolver.manifest, type)
    );

    writeStructuredIndex(resolver, type, nextIndex);
    writeJsonFileAtomic(recordPath, validation.value);

    return { record: validation.value };
  } catch (error) {
    return structuredErrorFromUnknown(error);
  }
}
