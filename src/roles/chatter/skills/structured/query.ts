import { hasRecordType } from "../../manifest";
import type { MemoryResolver } from "../../memory-resolver";
import {
  getIndexedFields,
  normalizeWhere,
  readRecordsForKeys,
  readStructuredIndex,
  recordMatchesConditions,
  selectCandidateKeys,
  type StructuredWhere
} from "./index-file";
import {
  structuredErrorFromUnknown,
  type StructuredError,
  unknownType
} from "./storage";

export type StructuredQueryResult = { records: unknown[] } | StructuredError;

export async function queryStructuredRecords(
  resolver: MemoryResolver,
  type: string,
  where: StructuredWhere
): Promise<StructuredQueryResult> {
  if (!hasRecordType(resolver.manifest, type)) {
    return unknownType(type);
  }

  const conditions = normalizeWhere(where);
  if (!conditions || conditions.length === 0) {
    return { error: "invalid_where", details: "where must be a condition or { and: [...] }" };
  }

  try {
    const index = readStructuredIndex(resolver, type);
    const candidateKeys = selectCandidateKeys(index, conditions, getIndexedFields(resolver.manifest, type));
    const recordsByKey = readRecordsForKeys(resolver, type, candidateKeys);
    return {
      records: candidateKeys
        .map((key) => recordsByKey.get(key))
        .filter((record) => record !== undefined && recordMatchesConditions(record, conditions))
    };
  } catch (error) {
    return structuredErrorFromUnknown(error);
  }
}
