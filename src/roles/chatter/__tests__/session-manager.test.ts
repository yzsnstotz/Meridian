import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatterStateStore, ChatterPersistedStateSchema } from "../chatter-state-store";
import { SessionManager } from "../session-manager";

describe("ChatterStateStore", () => {
  let root: string;
  let store: ChatterStateStore;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "chatter-store-"));
    store = new ChatterStateStore(root);
  });

  it("load() returns empty state when file absent", () => {
    const s = store.load();
    expect(s.agent_session_id).toBe(null);
    expect(s.in_flight_traces).toEqual([]);
  });

  it("save() then load() round-trips", () => {
    store.save({
      version: 1,
      agent_session_id: "abc",
      in_flight_traces: [
        {
          trace_id: "t1",
          purpose: "agent_turn",
          agent_session_id: "abc",
          registered_at: "2026-05-19T00:00:00.000Z"
        }
      ]
    });
    const reloaded = store.load();
    expect(reloaded.agent_session_id).toBe("abc");
    expect(reloaded.in_flight_traces.length).toBe(1);
    expect(reloaded.in_flight_traces[0].trace_id).toBe("t1");
  });

  it("save() creates the .chatter-state directory if missing", () => {
    store.save({ version: 1, agent_session_id: null, in_flight_traces: [] });
    expect(existsSync(store.stateDir)).toBe(true);
    expect(existsSync(store.stateFile)).toBe(true);
  });

  it("save() persists JSON that round-trips through ChatterPersistedStateSchema", () => {
    store.save({ version: 1, agent_session_id: "abc", in_flight_traces: [] });
    const raw = JSON.parse(readFileSync(store.stateFile, "utf8"));
    expect(() => ChatterPersistedStateSchema.parse(raw)).not.toThrow();
  });

  it("load() rejects corrupted state", () => {
    store.save({ version: 1, agent_session_id: null, in_flight_traces: [] });
    // Corrupt the file
    writeFileSync(store.stateFile, "{ not json");
    expect(() => store.load()).toThrow();
  });
});

describe("SessionManager", () => {
  let root: string;
  let store: ChatterStateStore;
  let mgr: SessionManager;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "chatter-sm-"));
    store = new ChatterStateStore(root);
    mgr = new SessionManager(store);
  });

  describe("start", () => {
    it("creates a fresh agent session_id on first call", () => {
      expect(mgr.currentSessionId).toBe(null);
      const id = mgr.start();
      expect(id).toBeTruthy();
      expect(mgr.currentSessionId).toBe(id);
    });

    it("is idempotent — subsequent calls return the same id", () => {
      const id1 = mgr.start();
      const id2 = mgr.start();
      expect(id1).toBe(id2);
    });

    it("persists the new session_id to the state store", () => {
      const id = mgr.start();
      const reloaded = store.load();
      expect(reloaded.agent_session_id).toBe(id);
    });
  });

  describe("newSession", () => {
    it("rotates session_id and clears in-flight traces", () => {
      const old = mgr.start();
      mgr.registerTrace({ trace_id: "t1", purpose: "agent_turn", agent_session_id: old });
      const { previousTraces, newSessionId } = mgr.newSession();
      expect(newSessionId).not.toBe(old);
      expect(previousTraces.length).toBe(1);
      expect(previousTraces[0].trace_id).toBe("t1");
      expect(mgr.currentInFlightTraces).toEqual([]);
    });

    it("works without an existing session (cold /new)", () => {
      const { previousTraces, newSessionId } = mgr.newSession();
      expect(previousTraces).toEqual([]);
      expect(newSessionId).toBeTruthy();
      expect(mgr.currentSessionId).toBe(newSessionId);
    });
  });

  describe("interrupt", () => {
    it("returns and clears in-flight traces but keeps session_id", () => {
      const id = mgr.start();
      mgr.registerTrace({ trace_id: "t1", purpose: "job_dispatch", agent_session_id: id });
      mgr.registerTrace({ trace_id: "t2", purpose: "agent_turn", agent_session_id: id });
      const cancelled = mgr.interrupt();
      expect(cancelled.map((c) => c.trace_id).sort()).toEqual(["t1", "t2"]);
      expect(mgr.currentInFlightTraces).toEqual([]);
      expect(mgr.currentSessionId).toBe(id);
    });

    it("is a no-op when nothing in flight", () => {
      mgr.start();
      const cancelled = mgr.interrupt();
      expect(cancelled).toEqual([]);
    });
  });

  describe("traces", () => {
    it("registerTrace + clearTrace round-trip", () => {
      const id = mgr.start();
      const t = mgr.registerTrace({ trace_id: "t1", purpose: "agent_turn", agent_session_id: id });
      expect(t.registered_at).toBeTruthy();
      const cleared = mgr.clearTrace("t1");
      expect(cleared?.trace_id).toBe("t1");
      expect(mgr.currentInFlightTraces).toEqual([]);
    });

    it("clearTrace returns null for unknown trace", () => {
      expect(mgr.clearTrace("nope")).toBe(null);
    });

    it("getTrace returns the registered trace or null", () => {
      mgr.start();
      mgr.registerTrace({ trace_id: "t1", purpose: "agent_turn", agent_session_id: mgr.currentSessionId });
      expect(mgr.getTrace("t1")?.trace_id).toBe("t1");
      expect(mgr.getTrace("nope")).toBe(null);
    });
  });

  describe("rehydrate", () => {
    it("restores session_id and in-flight traces from disk", () => {
      const id = mgr.start();
      mgr.registerTrace({ trace_id: "t1", purpose: "agent_turn", agent_session_id: id });
      const mgr2 = new SessionManager(new ChatterStateStore(root));
      mgr2.rehydrate();
      expect(mgr2.currentSessionId).toBe(id);
      expect(mgr2.currentInFlightTraces.length).toBe(1);
    });

    it("starts empty when nothing persisted", () => {
      const fresh = mkdtempSync(path.join(tmpdir(), "chatter-sm-"));
      const m = new SessionManager(new ChatterStateStore(fresh));
      m.rehydrate();
      expect(m.currentSessionId).toBe(null);
      expect(m.currentInFlightTraces).toEqual([]);
    });
  });

  describe("markSessionDead", () => {
    it("clears session_id and flags needsNewSession", () => {
      mgr.start();
      mgr.registerTrace({ trace_id: "t1", purpose: "agent_turn", agent_session_id: mgr.currentSessionId });
      mgr.markSessionDead();
      expect(mgr.currentSessionId).toBe(null);
      expect(mgr.currentInFlightTraces).toEqual([]);
      expect(mgr.needsNewSession).toBe(true);
    });
  });

  describe("probeAndRecover", () => {
    it("returns false and marks needsNew when probe says dead", async () => {
      mgr.start();
      const ok = await mgr.probeAndRecover(async () => false);
      expect(ok).toBe(false);
      expect(mgr.needsNewSession).toBe(true);
      expect(mgr.currentSessionId).toBe(null);
    });

    it("returns true and preserves state when probe says alive", async () => {
      const id = mgr.start();
      const ok = await mgr.probeAndRecover(async () => true);
      expect(ok).toBe(true);
      expect(mgr.currentSessionId).toBe(id);
      expect(mgr.needsNewSession).toBe(false);
    });

    it("returns false when no session_id exists", async () => {
      const ok = await mgr.probeAndRecover(async () => true);
      expect(ok).toBe(false);
      expect(mgr.needsNewSession).toBe(true);
    });
  });
});
