import { createLogger } from "../../logger";

const log = createLogger("stream_ndjson");

export function parseNdjsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    log.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        sample: trimmed.slice(0, 200)
      },
      "Skipping malformed NDJSON line"
    );
    return null;
  }
}

export async function* splitNdjsonStream(stream: AsyncIterable<Buffer | string>): AsyncIterable<unknown> {
  let buffered = "";

  for await (const chunk of stream) {
    buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";

    for (const line of lines) {
      const parsed = parseNdjsonLine(line);
      if (parsed !== null) {
        yield parsed;
      }
    }
  }

  if (!buffered.trim()) {
    return;
  }

  const parsed = parseNdjsonLine(buffered);
  if (parsed !== null) {
    yield parsed;
  }
}
