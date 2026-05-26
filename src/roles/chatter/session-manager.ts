import { randomUUID } from "node:crypto";
import {
  ChatterStateStore,
  type ChatterAgentSessionStatus,
  type ChatterInFlightTrace
} from "./chatter-state-store";

export type SessionProbe = (sessionId: string) => Promise<boolean>;

export interface ChatterSessionState {
  transcript_session_id: string;
  agent_session_id: string | null;
  agent_session_status: ChatterAgentSessionStatus;
  history_replay: boolean;
}

export interface SelfInitiatedTurnRequest {
  system_prompt_id: string;
  origin: "trigger";
  trigger_name: string;
}

export interface QueuedSelfInitiatedTurn extends SelfInitiatedTurnRequest {
  queued_at: string;
}

export class SessionManager {
  private agentSessionId: string | null = null;
  private agentSessionStatus: ChatterAgentSessionStatus = "unbound";
  private inFlight: Map<string, ChatterInFlightTrace> = new Map();
  private selfInitiatedTurnQueue: QueuedSelfInitiatedTurn[] = [];
  private needsNew = false;

  constructor(private readonly store: ChatterStateStore) {}

  get currentSessionId(): string | null {
    return this.agentSessionId;
  }

  get currentSessionStatus(): ChatterAgentSessionStatus {
    return this.agentSessionStatus;
  }

  get currentInFlightTraces(): ReadonlyArray<ChatterInFlightTrace> {
    return [...this.inFlight.values()];
  }

  get needsNewSession(): boolean {
    return this.needsNew;
  }

  get hasActiveAgentTurn(): boolean {
    return [...this.inFlight.values()].some((trace) => trace.purpose === "agent_turn");
  }

  get queuedSelfInitiatedTurnCount(): number {
    return this.selfInitiatedTurnQueue.length;
  }

  rehydrate(): void {
    const state = this.store.load();
    this.agentSessionId = state.agent_session_id;
    this.agentSessionStatus = state.agent_session_status;
    this.inFlight = new Map(state.in_flight_traces.map((t) => [t.trace_id, t]));
    this.needsNew = false;
  }

  /**
   * Legacy: generate a local UUID. Use bindAgentSession(threadId) instead
   * when the session_id is a real meridian-hub thread_id returned by the
   * intent:"spawn" handshake. Retained for tests / legacy code paths.
   */
  start(): string {
    if (this.agentSessionId !== null) return this.agentSessionId;
    this.agentSessionId = randomUUID();
    this.agentSessionStatus = "alive";
    this.needsNew = false;
    this.persist();
    return this.agentSessionId;
  }

  /**
   * Bind to a concrete agent thread_id returned by meridian-hub's spawn
   * handshake. This replaces any prior agent_session_id and persists.
   */
  bindAgentSession(threadId: string): void {
    this.agentSessionId = threadId;
    this.agentSessionStatus = "alive";
    this.needsNew = false;
    this.persist();
  }

  /**
   * Clear the bound agent session without minting a new local UUID. Used
   * during /new after the old agent thread has been killed and before a
   * fresh spawn handshake fires on the next turn.
   */
  unbindAgentSession(): void {
    this.agentSessionId = null;
    this.agentSessionStatus = "restarting";
    this.inFlight.clear();
    this.selfInitiatedTurnQueue = [];
    this.needsNew = true;
    this.persist();
  }

  markSessionRestarting(): void {
    this.agentSessionId = null;
    this.agentSessionStatus = "restarting";
    this.needsNew = true;
    this.persist();
  }

  newSession(): { previousTraces: ChatterInFlightTrace[]; newSessionId: string } {
    const previousTraces = [...this.inFlight.values()];
    this.inFlight.clear();
    this.selfInitiatedTurnQueue = [];
    this.agentSessionId = randomUUID();
    this.agentSessionStatus = "alive";
    this.needsNew = false;
    this.persist();
    return { previousTraces, newSessionId: this.agentSessionId };
  }

  /**
   * Returns true when this session manager issued an outbound message
   * whose response carries the given trace_id. Used by ChatterRole's
   * BaseRole.claimsTrace implementation so RoleRunner.dispatch can route
   * inbound HubResults by trace_id when result.thread_id is the agent's
   * (not the role's own).
   */
  claimsTrace(traceId: string): boolean {
    return this.inFlight.has(traceId);
  }

  interrupt(): ChatterInFlightTrace[] {
    const traces = [...this.inFlight.values()];
    this.inFlight.clear();
    this.selfInitiatedTurnQueue = [];
    this.persist();
    return traces;
  }

  enqueueSelfInitiatedTurn(request: SelfInitiatedTurnRequest): QueuedSelfInitiatedTurn {
    const entry: QueuedSelfInitiatedTurn = {
      ...request,
      queued_at: new Date().toISOString()
    };
    this.selfInitiatedTurnQueue.push(entry);
    return entry;
  }

  shiftSelfInitiatedTurn(): QueuedSelfInitiatedTurn | null {
    return this.selfInitiatedTurnQueue.shift() ?? null;
  }

  clearSelfInitiatedTurnQueue(): void {
    this.selfInitiatedTurnQueue = [];
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
    this.agentSessionStatus = "dead";
    this.inFlight.clear();
    this.selfInitiatedTurnQueue = [];
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
    this.agentSessionStatus = "alive";
    this.persist();
    return true;
  }

  sessionStateFor(transcriptSessionId: string, historyReplay = false): ChatterSessionState {
    return {
      transcript_session_id: transcriptSessionId,
      agent_session_id: historyReplay ? null : this.agentSessionId,
      agent_session_status: historyReplay ? "unbound" : this.agentSessionStatus,
      history_replay: historyReplay
    };
  }

  private persist(): void {
    const current = this.store.load();
    this.store.save({
      ...current,
      version: 1,
      agent_session_id: this.agentSessionId,
      agent_session_status: this.agentSessionStatus,
      in_flight_traces: [...this.inFlight.values()]
    });
  }
}
