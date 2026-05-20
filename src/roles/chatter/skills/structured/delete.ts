import { hasRecordType } from "../../manifest";
import type { MemoryResolver } from "../../memory-resolver";
import {
  getIndexedFields,
  readRecordsForKeys,
  readStructuredIndex,
  rebuildStructuredIndex,
  writeStructuredIndex
} from "./index-file";
import {
  fileExists,
  removeFileIfExists,
  resolveStructuredRecordPath,
  structuredErrorFromUnknown,
  type StructuredError,
  unknownType
} from "./storage";

export type StructuredDeleteResult = { deleted: true } | StructuredError;

export async function deleteStructuredRecord(
  resolver: MemoryResolver,
  type: string,
  key: string
): Promise<StructuredDeleteResult> {
  if (!hasRecordType(resolver.manifest, type)) {
    return unknownType(type);
  }

  try {
    const recordPath = resolveStructuredRecordPath(resolver, type, key);
    if (!fileExists(recordPath)) {
      return { error: "not_found" };
    }

    const index = readStructuredIndex(resolver, type);
    const nextKeys = index.keys.filter((existing) => existing !== key);
    const records = readRecordsForKeys(resolver, type, nextKeys);
    removeFileIfExists(recordPath);
    writeStructuredIndex(
      resolver,
      type,
      rebuildStructuredIndex(nextKeys, records, getIndexedFields(resolver.manifest, type))
    );

    return { deleted: true };
  } catch (error) {
    return structuredErrorFromUnknown(error);
  }
}
