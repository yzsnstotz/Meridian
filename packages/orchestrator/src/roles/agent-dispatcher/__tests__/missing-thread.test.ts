import { describe, expect, it } from "vitest";

import { isHubTransportEvidence, isMissingThreadEvidence } from "../missing-thread";

describe("isMissingThreadEvidence", () => {
  // Regression: the watchdog's previous local matcher missed this exact
  // wording, which the hub returns from kill() when the thread has been
  // recycled or never registered. Every watchdog tick re-attempted the same
  // kill against a hub that always said no, producing the 315k+ "terminal
  // worker cleanup kill failed" warnings observed on 2026-05-18.
  it("recognises the hub's 'No registered agent instance found' kill error", () => {
    expect(
      isMissingThreadEvidence(
        "kill failed: Routing failed: No registered agent instance found for thread_id=codex_19"
      )
    ).toBe(true);
  });

  it("recognises 'is not registered' from hub interrupt/attach/restart paths", () => {
    expect(
      isMissingThreadEvidence(
        "Cannot attach session; thread_id=codex_07 is not registered"
      )
    ).toBe(true);
  });

  it("recognises 'unknown thread' wording", () => {
    expect(isMissingThreadEvidence("kill failed: unknown thread codex_42")).toBe(true);
  });

  it("recognises 'no thread is attached'", () => {
    expect(isMissingThreadEvidence("hub: no thread is attached to channel")).toBe(true);
  });

  it("recognises 'not found'", () => {
    expect(isMissingThreadEvidence("thread_id=codex_99 not found")).toBe(true);
  });

  it("returns false on null/empty/whitespace input", () => {
    expect(isMissingThreadEvidence(null)).toBe(false);
    expect(isMissingThreadEvidence(undefined)).toBe(false);
    expect(isMissingThreadEvidence("")).toBe(false);
    expect(isMissingThreadEvidence("   ")).toBe(false);
  });

  it("returns false on unrelated error messages", () => {
    expect(isMissingThreadEvidence("Routing failed: timeout after 30000ms")).toBe(false);
    expect(isMissingThreadEvidence("Cannot spawn agentapi process")).toBe(false);
  });
});

describe("isHubTransportEvidence", () => {
  // Regression: this exact wording floods the log on agent-dispatcher-98b73906
  // (315k+ "terminal worker cleanup kill failed" entries on 2026-05-19). The
  // canonical missing-thread matcher correctly does NOT match this (kill
  // outcome is unknown), so the watchdog needs a separate signal to back off.
  it("recognises 'IPC request completed without response body' from kill", () => {
    expect(
      isHubTransportEvidence(
        "kill failed: Server error: IPC request completed without response body"
      )
    ).toBe(true);
  });

  it("recognises the same wording from A2A / attach paths", () => {
    expect(isHubTransportEvidence("A2A request completed without a response body")).toBe(true);
    expect(isHubTransportEvidence("Attach request completed without a response body")).toBe(true);
  });

  it("recognises ECONNREFUSED / ETIMEDOUT / fetch failed", () => {
    expect(
      isHubTransportEvidence("processes: fetchAgentapiInstanceIndex failed: connect ECONNREFUSED /tmp/hub-core.sock")
    ).toBe(true);
    expect(isHubTransportEvidence("Routing failed: ETIMEDOUT")).toBe(true);
    expect(isHubTransportEvidence("Meridian API unreachable: fetch failed")).toBe(true);
  });

  it("recognises generic 'Server error' (Hub 5xx envelope)", () => {
    expect(isHubTransportEvidence("kill failed: Server error: backend unavailable")).toBe(true);
  });

  it("recognises timeout wording", () => {
    expect(isHubTransportEvidence("timeout on continue-dispatcher")).toBe(true);
    expect(isHubTransportEvidence("Request timed out after 30000ms")).toBe(true);
  });

  it("returns false on missing-thread errors (handled by isMissingThreadEvidence)", () => {
    expect(
      isHubTransportEvidence(
        "kill failed: Routing failed: No registered agent instance found for thread_id=codex_19"
      )
    ).toBe(false);
    expect(isHubTransportEvidence("thread_id=codex_42 is not registered")).toBe(false);
  });

  it("returns false on null/empty/whitespace input", () => {
    expect(isHubTransportEvidence(null)).toBe(false);
    expect(isHubTransportEvidence(undefined)).toBe(false);
    expect(isHubTransportEvidence("")).toBe(false);
    expect(isHubTransportEvidence("   ")).toBe(false);
  });

  it("returns false on unrelated errors", () => {
    expect(isHubTransportEvidence("Cannot spawn agentapi process")).toBe(false);
    expect(isHubTransportEvidence("Worker not found in lifecycle state: DISPATCHER")).toBe(false);
  });
});
