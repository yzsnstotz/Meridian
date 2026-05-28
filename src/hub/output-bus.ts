import type { A2AAdapterLike, A2AMessage } from "../shared/a2a-adapter";
import { DefaultA2AAdapter } from "../shared/a2a-adapter";
import { DiffEngine } from "../shared/diff-engine";
import type { OutputDelta } from "../shared/stream-adapter";
import type { AgentType, ReplyChannel } from "../types";

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

/**
 * Tells `dispatchOutputBusDelta` (in HubServer) where to forward each delta
 * for a given trace_id. Registered by whichever subsystem owns the trace —
 * the monitor-progress poller for `"monitor_progress"`, and HubRouter's
 * streaming runs for `"agent_stream"`. Cleared in a `finally` once the run
 * (or snapshot) ends so dispatchOutputBusDelta short-circuits afterward.
 */
export interface OutputBusDeliveryContext {
  threadId: string;
  source: AgentType;
  timestamp: string;
  replyChannels: ReplyChannel[];
  historyBacked: boolean;
  /**
   * `"monitor_progress"` (default for back-compat) forwards every delta as
   * a HubResult to the reply channel. `"agent_stream"` forwards only
   * `"working"`-phase deltas — the final `"result"` / `"error"` HubResult
   * for that trace already flows through the run-return path, so we must
   * not double-emit it here.
   */
  mode?: "monitor_progress" | "agent_stream";
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
  /**
   * Per-trace delivery context. Mutated by `beginAdapterDelivery` /
   * `endAdapterDelivery`. The HubServer's `dispatchOutputBusDelta` sink
   * reads from here to decide where (and whether) to forward a delta.
   */
  private readonly deliveryContextByTrace = new Map<string, OutputBusDeliveryContext>();

  constructor(options: OutputBusOptions = {}) {
    this.diffEngine = options.diffEngine ?? new DiffEngine();
    this.a2aAdapter = options.a2aAdapter ?? new DefaultA2AAdapter();
    this.adapterOutput = options.adapterOutput ?? null;
    this.websocketOutput = options.websocketOutput ?? null;
    this.recordOutput = options.recordOutput ?? null;
  }

  /** Register a delivery target for `traceId`. Idempotent overwrite. */
  beginAdapterDelivery(traceId: string, ctx: OutputBusDeliveryContext): void {
    this.deliveryContextByTrace.set(traceId, ctx);
  }

  /** Drop the delivery target for `traceId`. No-op if absent. */
  endAdapterDelivery(traceId: string): void {
    this.deliveryContextByTrace.delete(traceId);
  }

  /** Lookup, used by the HubServer dispatch sink. */
  getAdapterDeliveryContext(traceId: string): OutputBusDeliveryContext | undefined {
    return this.deliveryContextByTrace.get(traceId);
  }

  /** Drop everything — used by HubServer.close so we don't leak entries. */
  clearAdapterDeliveryContexts(): void {
    this.deliveryContextByTrace.clear();
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

  async pushDelta(traceId: string, delta: OutputDelta): Promise<void> {
    await this.dispatch({
      ...delta,
      traceId
    });
  }

  async pushSnapshot(traceId: string, snapshot: string): Promise<void> {
    const text = this.diffEngine.diff(traceId, snapshot);
    if (text.length === 0) {
      return;
    }

    await this.dispatch({
      traceId,
      phase: "working",
      text,
      final: false
    });
  }

  async finalize(traceId: string, result: unknown): Promise<void> {
    await this.dispatch(normalizeFinalizeDelta(traceId, result));
    this.diffEngine.clear(traceId);
  }

  private async dispatch(delta: OutputDelta): Promise<void> {
    if (delta.text === undefined && delta.data === undefined && !delta.final) {
      return;
    }

    const message = this.toA2AMessage(delta);
    this.fireRecordHook(delta.traceId, delta, message);
    // Adapter sink (= reply-channel writer) is AWAITED. When agent streaming
    // is enabled for a trace, each delta must be fully delivered to the
    // socket FIFO before the next one is pushed — otherwise the final
    // HubResult (sent through the run-return path) can overtake in-flight
    // partials and the consumer drops them as "no_pending".
    // The websocket sink and record hook stay fire-and-forget — they are
    // observability paths whose ordering doesn't gate streaming UX.
    await this.fireSinkAwaited(this.adapterOutput, delta.traceId, message, delta);
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

  private async fireSinkAwaited(
    sink: OutputBusDispatchSink | null,
    traceId: string,
    message: A2AMessage,
    delta: OutputDelta
  ): Promise<void> {
    if (!sink) {
      return;
    }
    try {
      await sink(traceId, message, delta);
    } catch {
      // Swallow — the sink's own error logging is authoritative; we must
      // not abort the for-await loop on a flaky downstream channel.
    }
  }

  private toA2AMessage(delta: OutputDelta): A2AMessage {
    return this.a2aAdapter.outputDeltaToA2A(delta);
  }
}
