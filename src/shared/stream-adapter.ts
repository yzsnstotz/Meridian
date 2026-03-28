export const OUTPUT_PHASES = ["working", "result", "error"] as const;
export type OutputPhase = (typeof OUTPUT_PHASES)[number];

export interface OutputDelta {
  traceId: string;
  spanId?: string;
  phase: OutputPhase;
  text?: string;
  data?: unknown;
  final: boolean;
}

export interface StreamAdapter {
  readonly supportsStream: boolean;
  stream(sessionId: string): AsyncIterable<OutputDelta>;
}
