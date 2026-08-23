import type { OutputDelta } from "../stream-adapter";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null ? (value as JsonRecord) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseGeminiEvent(event: unknown): OutputDelta | null {
  const record = asRecord(event);
  if (!record) {
    return null;
  }

  const type = asString(record.type);
  const traceId = asString(record.session_id);

  if (!type || !traceId) {
    return null;
  }

  if (type === "message") {
    if (asString(record.role) !== "assistant") {
      return null;
    }

    const text = asString(record.content);
    if (!text) {
      return null;
    }

    return {
      traceId,
      phase: "working",
      text,
      final: false
    };
  }

  if (type === "result") {
    return {
      traceId,
      phase: asString(record.status) === "success" ? "result" : "error",
      ...(record.stats !== undefined ? { data: record.stats } : {}),
      final: true
    };
  }

  return null;
}

export function createGeminiStreamParser(): (event: unknown) => OutputDelta | null {
  let sessionId: string | undefined;

  return (event: unknown) => {
    const record = asRecord(event);
    const nextSessionId = asString(record?.session_id);
    if (nextSessionId) {
      sessionId = nextSessionId;
    }

    if (!record || !sessionId || typeof record.session_id === "string") {
      return parseGeminiEvent(event);
    }

    return parseGeminiEvent({
      ...record,
      session_id: sessionId
    });
  };
}
