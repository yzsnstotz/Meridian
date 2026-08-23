interface MeridianToolResultPayload {
  ok?: unknown;
  error?: unknown;
  data?: {
    thread_id?: unknown;
  };
  thread_id?: unknown;
}

export function parseSpawnCliOutput(rawOutput: string): { threadId: string | null; error: string | null } {
  const parsed = parseMeridianToolResult(rawOutput);
  if (!parsed) {
    return {
      threadId: null,
      error: null
    };
  }

  if (parsed.ok === false && typeof parsed.error === "string" && parsed.error.trim().length > 0) {
    return {
      threadId: null,
      error: parsed.error.trim()
    };
  }

  const candidate = typeof parsed.data?.thread_id === "string"
    ? parsed.data.thread_id
    : typeof parsed.thread_id === "string"
      ? parsed.thread_id
      : null;

  return {
    threadId: candidate?.trim() ? candidate.trim() : null,
    error: null
  };
}

export function extractSpawnCliError(error: unknown): string | null {
  for (const streamName of ["stdout", "stderr"] as const) {
    const rawOutput = readErrorStream(error, streamName);
    if (!rawOutput) {
      continue;
    }

    const parsed = parseSpawnCliOutput(rawOutput);
    if (parsed.error) {
      return parsed.error;
    }
  }

  return null;
}

function parseMeridianToolResult(rawOutput: string): MeridianToolResultPayload | null {
  const trimmed = rawOutput.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as MeridianToolResultPayload;
  } catch {
    // Fall through and try line-delimited JSON, which is how the CLI writes payloads.
  }

  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line || !line.startsWith("{") || !line.endsWith("}")) {
      continue;
    }

    try {
      return JSON.parse(line) as MeridianToolResultPayload;
    } catch {
      // Ignore non-JSON log lines.
    }
  }

  return null;
}

function readErrorStream(error: unknown, streamName: "stdout" | "stderr"): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const streamValue = (error as { stdout?: unknown; stderr?: unknown })[streamName];
  return typeof streamValue === "string" && streamValue.trim().length > 0 ? streamValue : null;
}
