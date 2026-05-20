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

export type StructuredListResult = { keys: string[] } | StructuredError;

export async function listStructuredRecords(
  resolver: MemoryResolver,
  type: string,
  filter?: StructuredWhere
): Promise<StructuredListResult> {
  if (!hasRecordType(resolver.manifest, type)) {
    return unknownType(type);
  }

  try {
    const index = readStructuredIndex(resolver, type);
    if (filter === undefined) {
      return { keys: index.keys };
    }

    const conditions = normalizeWhere(filter);
    if (!conditions || conditions.length === 0) {
      return { error: "invalid_where", details: "filter must be a condition or { and: [...] }" };
    }

    const candidateKeys = selectCandidateKeys(index, conditions, getIndexedFields(resolver.manifest, type));
    const recordsByKey = readRecordsForKeys(resolver, type, candidateKeys);
    return {
      keys: candidateKeys.filter((key) => {
        const record = recordsByKey.get(key);
        return record !== undefined && recordMatchesConditions(record, conditions);
      })
    };
  } catch (error) {
    return structuredErrorFromUnknown(error);
  }
}
