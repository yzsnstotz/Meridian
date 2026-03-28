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
