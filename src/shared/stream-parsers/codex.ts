import type { OutputDelta } from "../stream-adapter";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null ? (value as JsonRecord) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function joinCommandSegments(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const segments = value.filter((segment): segment is string => typeof segment === "string" && segment.length > 0);
  return segments.length > 0 ? segments.join(" ") : undefined;
}

function extractCommand(item: JsonRecord): string | undefined {
  const directCommand =
    asString(item.command) ??
    asString(item.command_line) ??
    asString(item.text) ??
    joinCommandSegments(item.command);
  if (directCommand) {
    return directCommand;
  }

  const commandRecord = asRecord(item.command);
  if (!commandRecord) {
    return undefined;
  }

  return (
    asString(commandRecord.raw) ??
    asString(commandRecord.command) ??
    asString(commandRecord.text) ??
    asString(commandRecord.shell_command) ??
    joinCommandSegments(commandRecord.argv) ??
    joinCommandSegments(commandRecord.args)
  );
}

function extractOutput(item: JsonRecord): string | undefined {
  const directOutput =
    asString(item.aggregated_output) ??
    asString(item.output) ??
    asString(item.text) ??
    asString(item.stdout) ??
    asString(item.stderr);
  if (directOutput) {
    return directOutput;
  }

  const outputRecord = asRecord(item.output);
  if (!outputRecord) {
    return undefined;
  }

  return (
    asString(outputRecord.aggregated_output) ??
    asString(outputRecord.text) ??
    asString(outputRecord.stdout) ??
    asString(outputRecord.stderr)
  );
}

export function extractThreadId(event: unknown): string | null {
  const record = asRecord(event);
  if (asString(record?.type) !== "thread.started") {
    return null;
  }

  return asString(record?.thread_id) ?? null;
}

export function parseCodexEvent(event: unknown): OutputDelta | null {
  const record = asRecord(event);
  const type = asString(record?.type);
  const traceId = asString(record?.thread_id);
  if (!record || !type || !traceId) {
    return null;
  }

  if (type === "thread.started" || type === "turn.started") {
    return null;
  }

  const item = asRecord(record.item);
  const spanId = asString(item?.id);

  if (type === "item.started" && item && asString(item.type) === "command_execution") {
    const command = extractCommand(item);
    if (!command) {
      return null;
    }

    return {
      traceId,
      spanId,
      phase: "working",
      data: {
        type: "tool_call",
        command,
        status: "in_progress"
      },
      final: false
    };
  }

  if (type === "item.completed" && item && asString(item.type) === "agent_message") {
    const text = asString(item?.text);
    if (!text) {
      return null;
    }

    return {
      traceId,
      spanId,
      phase: "working",
      text,
      final: false
    };
  }

  if (type === "item.completed" && item && asString(item.type) === "command_execution") {
    return {
      traceId,
      spanId,
      phase: "working",
      data: {
        type: "tool_result",
        output: extractOutput(item),
        exit_code: asNumber(item.exit_code)
      },
      final: false
    };
  }

  if (type === "turn.completed") {
    return {
      traceId,
      phase: "result",
      data: record.usage,
      final: true
    };
  }

  return null;
}

export function createCodexStreamParser(): (event: unknown) => OutputDelta | null {
  let threadId: string | undefined;

  return (event: unknown) => {
    const record = asRecord(event);
    const nextThreadId = extractThreadId(event);
    if (nextThreadId) {
      threadId = nextThreadId;
    }

    if (!record || !threadId || typeof record.thread_id === "string") {
      return parseCodexEvent(event);
    }

    return parseCodexEvent({
      ...record,
      thread_id: threadId
    });
  };
}
