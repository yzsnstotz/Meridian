import { createLogger } from "../../logger";

const log = createLogger("hub");

export function parseNdjsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    log.warn(
      {
        err: error,
        line_preview: trimmed.slice(0, 200)
      },
      "Skipping malformed NDJSON line"
    );
    return undefined;
  }
}

export async function* splitNdjsonStream(
  stream: AsyncIterable<Buffer | string>
): AsyncIterable<unknown> {
  const decoder = new TextDecoder();
  let buffered = "";

  for await (const chunk of stream) {
    buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });

    while (true) {
      const newlineIndex = buffered.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = buffered.slice(0, newlineIndex).replace(/\r$/, "");
      buffered = buffered.slice(newlineIndex + 1);

      const parsed = parseNdjsonLine(line);
      if (parsed !== undefined) {
        yield parsed;
      }
    }
  }

  buffered += decoder.decode();
  const trailingLine = buffered.replace(/\r$/, "");
  const parsed = parseNdjsonLine(trailingLine);
  if (parsed !== undefined) {
    yield parsed;
  }
}
