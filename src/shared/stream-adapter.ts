export type OutputDeltaPhase = "working" | "result" | "error";

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
