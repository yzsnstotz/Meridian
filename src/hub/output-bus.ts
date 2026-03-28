import type { A2AAdapterLike, A2AMessage } from "../shared/a2a-adapter";
import { DefaultA2AAdapter } from "../shared/a2a-adapter";
import { DiffEngine } from "../shared/diff-engine";
import type { OutputDelta } from "../shared/stream-adapter";

type MaybePromise<T> = T | Promise<T>;

export type OutputBusDispatchSink = (
  traceId: string,
  message: A2AMessage,
  delta: OutputDelta
) => MaybePromise<void>;

export type OutputBusRecordHook = (
  traceId: string,
  delta: OutputDelta,
  message: A2AMessage
) => MaybePromise<void>;

export interface OutputBusOptions {
  diffEngine?: DiffEngine;
  a2aAdapter?: A2AAdapterLike;
  adapterOutput?: OutputBusDispatchSink;
  websocketOutput?: OutputBusDispatchSink;
  recordOutput?: OutputBusRecordHook;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOutputPhase(value: unknown): value is OutputDelta["phase"] {
  return value === "working" || value === "result" || value === "error";
}

function normalizeFinalizeDelta(traceId: string, result: unknown): OutputDelta {
  if (typeof result === "string") {
    return {
      traceId,
      phase: "result",
      text: result,
      final: true
    };
  }

  if (result instanceof Error) {
    return {
      traceId,
      phase: "error",
      text: result.message,
      final: true
    };
  }

  if (!isRecord(result)) {
    return {
      traceId,
      phase: "result",
      final: true
    };
  }

  const explicitPhase = result.phase;
  if (isOutputPhase(explicitPhase)) {
    return {
      traceId,
      spanId: typeof result.spanId === "string" ? result.spanId : undefined,
      phase: explicitPhase,
      text: typeof result.text === "string" ? result.text : undefined,
      data: result.data,
      final: true
    };
  }

  const status = result.status;
  const phase =
    status === "error" || status === "timeout"
      ? "error"
      : status === "partial"
        ? "working"
        : "result";

  return {
    traceId,
    phase,
    text:
      typeof result.content === "string"
        ? result.content
        : typeof result.text === "string"
          ? result.text
          : undefined,
    data: result.data,
    final: true
  };
}

export class OutputBus {
  private readonly diffEngine: DiffEngine;
  private readonly a2aAdapter: A2AAdapterLike;
  private adapterOutput: OutputBusDispatchSink | null;
  private websocketOutput: OutputBusDispatchSink | null;
  private recordOutput: OutputBusRecordHook | null;

  constructor(options: OutputBusOptions = {}) {
    this.diffEngine = options.diffEngine ?? new DiffEngine();
    this.a2aAdapter = options.a2aAdapter ?? new DefaultA2AAdapter();
    this.adapterOutput = options.adapterOutput ?? null;
    this.websocketOutput = options.websocketOutput ?? null;
    this.recordOutput = options.recordOutput ?? null;
  }

  setAdapterOutput(sink: OutputBusDispatchSink | null | undefined): void {
    this.adapterOutput = sink ?? null;
  }

  setWebsocketOutput(sink: OutputBusDispatchSink | null | undefined): void {
    this.websocketOutput = sink ?? null;
  }

  setRecordOutput(hook: OutputBusRecordHook | null | undefined): void {
    this.recordOutput = hook ?? null;
  }

  pushDelta(traceId: string, delta: OutputDelta): void {
    this.dispatch({
      ...delta,
      traceId
    });
  }

  pushSnapshot(traceId: string, snapshot: string): void {
    const text = this.diffEngine.diff(traceId, snapshot);
    if (text.length === 0) {
      return;
    }

    this.dispatch({
      traceId,
      phase: "working",
      text,
      final: false
    });
  }

  finalize(traceId: string, result: unknown): void {
    this.dispatch(normalizeFinalizeDelta(traceId, result));
    this.diffEngine.clear(traceId);
  }

  private dispatch(delta: OutputDelta): void {
    if (delta.text === undefined && delta.data === undefined && !delta.final) {
      return;
    }

    const message = this.toA2AMessage(delta);
    this.fireRecordHook(delta.traceId, delta, message);
    this.fireSink(this.adapterOutput, delta.traceId, message, delta);
    this.fireSink(this.websocketOutput, delta.traceId, message, delta);
  }

  private fireRecordHook(traceId: string, delta: OutputDelta, message: A2AMessage): void {
    if (!this.recordOutput) {
      return;
    }

    void Promise.resolve(this.recordOutput(traceId, delta, message));
  }

  private fireSink(
    sink: OutputBusDispatchSink | null,
    traceId: string,
    message: A2AMessage,
    delta: OutputDelta
  ): void {
    if (!sink) {
      return;
    }

    void Promise.resolve(sink(traceId, message, delta));
  }

  private toA2AMessage(delta: OutputDelta): A2AMessage {
    return this.a2aAdapter.outputDeltaToA2A(delta);
  }
}
