import { splitNdjsonStream } from "./stream-parsers/ndjson";

export const OUTPUT_PHASES = ["working", "result", "error"] as const;
export type OutputDeltaPhase = (typeof OUTPUT_PHASES)[number];
export type OutputPhase = OutputDeltaPhase;

export interface OutputDelta {
  traceId: string;
  spanId?: string;
  phase: OutputDeltaPhase;
  text?: string;
  data?: unknown;
  final: boolean;
}

export interface StreamAdapter {
  readonly supportsStream: boolean;
  stream(sessionId: string): AsyncIterable<OutputDelta>;
}

export async function* streamFromSpawn(
  stdout: AsyncIterable<Buffer | string>,
  parser: (event: unknown) => OutputDelta | null
): AsyncIterable<OutputDelta> {
  let lastTraceId = "stream-error";

  try {
    for await (const event of splitNdjsonStream(stdout)) {
      const delta = parser(event);
      if (!delta) {
        continue;
      }

      if (typeof delta.traceId === "string" && delta.traceId.length > 0) {
        lastTraceId = delta.traceId;
      }
      yield delta;
    }
  } catch (error) {
    yield {
      traceId: lastTraceId,
      phase: "error",
      text: error instanceof Error ? error.message : String(error),
      data: {
        type: "stream_error",
        recoverable: true
      },
      final: true
    };
  }
}
