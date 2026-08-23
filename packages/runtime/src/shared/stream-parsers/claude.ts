import type { OutputDelta } from "../stream-adapter";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null ? (value as JsonRecord) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractAssistantText(message: unknown): string | undefined {
  const messageRecord = asRecord(message);
  const content = Array.isArray(messageRecord?.content) ? messageRecord.content : [];
  const text = content
    .filter((item) => asString(asRecord(item)?.type) === "text")
    .map((item) => asString(asRecord(item)?.text))
    .filter((value): value is string => value !== undefined)
    .join("");

  return text.length > 0 ? text : undefined;
}

export function parseClaudeEvent(event: unknown): OutputDelta | null {
  const record = asRecord(event);
  if (!record) {
    return null;
  }

  const type = asString(record?.type);
  const traceId = asString(record?.session_id);

  if (!type || !traceId) {
    return null;
  }

  if (type === "assistant") {
    const text = extractAssistantText(record.message);
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
      phase: record.is_error === true ? "error" : "result",
      text: asString(record.result),
      ...(record.usage !== undefined ? { data: record.usage } : {}),
      final: true
    };
  }

  return null;
}

export function createClaudeStreamParser(): (event: unknown) => OutputDelta | null {
  let sessionId: string | undefined;

  return (event: unknown) => {
    const record = asRecord(event);
    const nextSessionId = asString(record?.session_id);
    if (nextSessionId) {
      sessionId = nextSessionId;
    }

    if (!record || !sessionId || typeof record.session_id === "string") {
      return parseClaudeEvent(event);
    }

    return parseClaudeEvent({
      ...record,
      session_id: sessionId
    });
  };
}
