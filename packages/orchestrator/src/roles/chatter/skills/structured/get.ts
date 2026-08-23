import { hasRecordType } from "../../manifest";
import type { MemoryResolver } from "../../memory-resolver";
import {
  fileExists,
  readJsonFile,
  resolveStructuredRecordPath,
  structuredErrorFromUnknown,
  type StructuredError,
  unknownType
} from "./storage";

export type StructuredGetResult = { record: unknown } | StructuredError;

export async function getStructuredRecord(
  resolver: MemoryResolver,
  type: string,
  key: string
): Promise<StructuredGetResult> {
  if (!hasRecordType(resolver.manifest, type)) {
    return unknownType(type);
  }

  try {
    const recordPath = resolveStructuredRecordPath(resolver, type, key);
    if (!fileExists(recordPath)) {
      return { error: "not_found" };
    }
    return { record: readJsonFile(recordPath) };
  } catch (error) {
    return structuredErrorFromUnknown(error);
  }
}
