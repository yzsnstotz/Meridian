import { randomUUID } from "node:crypto";
import { ChatterStateStore, type ChatterInFlightTrace, EMPTY_CHATTER_STATE } from "./chatter-state-store";

export type SessionProbe = (sessionId: string) => Promise<boolean>;

export class SessionManager {
  private agentSessionId: string | null = null;
  private inFlight: Map<string, ChatterInFlightTrace> = new Map();
  private needsNew = false;

  constructor(private readonly store: ChatterStateStore) {}

  get currentSessionId(): string | null {
    return this.agentSessionId;
  }

  get currentInFlightTraces(): ReadonlyArray<ChatterInFlightTrace> {
    return [...this.inFlight.values()];
  }

  get needsNewSession(): boolean {
    return this.needsNew;
  }

  rehydrate(): void {
    const state = this.store.load();
    this.agentSessionId = state.agent_session_id;
    this.inFlight = new Map(state.in_flight_traces.map((t) => [t.trace_id, t]));
    this.needsNew = false;
  }

  start(): string {
    if (this.agentSessionId !== null) return this.agentSessionId;
    this.agentSessionId = randomUUID();
    this.needsNew = false;
    this.persist();
    return this.agentSessionId;
  }

  newSession(): { previousTraces: ChatterInFlightTrace[]; newSessionId: string } {
    const previousTraces = [...this.inFlight.values()];
    this.inFlight.clear();
    this.agentSessionId = randomUUID();
    this.needsNew = false;
    this.persist();
    return { previousTraces, newSessionId: this.agentSessionId };
  }

  interrupt(): ChatterInFlightTrace[] {
    const traces = [...this.inFlight.values()];
    this.inFlight.clear();
    this.persist();
    return traces;
  }

  registerTrace(trace: Omit<ChatterInFlightTrace, "registered_at">): ChatterInFlightTrace {
    const entry: ChatterInFlightTrace = { ...trace, registered_at: new Date().toISOString() };
    this.inFlight.set(entry.trace_id, entry);
    this.persist();
    return entry;
  }

  clearTrace(traceId: string): ChatterInFlightTrace | null {
    const entry = this.inFlight.get(traceId);
    if (!entry) return null;
    this.inFlight.delete(traceId);
    this.persist();
    return entry;
  }

  getTrace(traceId: string): ChatterInFlightTrace | null {
    return this.inFlight.get(traceId) ?? null;
  }

  markSessionDead(): void {
    this.agentSessionId = null;
    this.inFlight.clear();
    this.needsNew = true;
    this.persist();
  }

  async probeAndRecover(probe: SessionProbe): Promise<boolean> {
    if (this.agentSessionId === null) {
      this.needsNew = true;
      return false;
    }
    const alive = await probe(this.agentSessionId);
    if (!alive) {
      this.markSessionDead();
      return false;
    }
    return true;
  }

  private persist(): void {
    this.store.save({
      ...EMPTY_CHATTER_STATE,
      version: 1,
      agent_session_id: this.agentSessionId,
      in_flight_traces: [...this.inFlight.values()]
    });
  }
}
