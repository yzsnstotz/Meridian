import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryResolver } from "../memory-resolver";
import { loadManifestFromTemplate } from "../manifest";
import { ChatterStateStore } from "../chatter-state-store";
import { SessionManager } from "../session-manager";
import { dispatchCodingJob, isTransportStallError } from "../job-dispatch";
import type { HubMessage } from "../../../types";

const CHATTER_THREAD_ID = "chatter-tenant-a";
const ROLES_SOCKET = "/tmp/meridian-roles.sock";

function makeDeps(root: string) {
  const sent: HubMessage[] = [];
  const resolver = new MemoryResolver(root, loadManifestFromTemplate("flat-log"));
  const store = new ChatterStateStore(root);
  const sessionMgr = new SessionManager(store);
  sessionMgr.start();
  const sendToHub = async (msg: HubMessage) => {
    sent.push(msg);
  };
  return { sent, resolver, store, sessionMgr, sendToHub };
}

describe("dispatchCodingJob", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-job-")));
  });

  it("builds a correct hub message to agent-dispatcher and returns trace_id", async () => {
    const deps = makeDeps(root);
    const res = await dispatchCodingJob({
      args: { instruction: "build X" },
      chatterThreadId: CHATTER_THREAD_ID,
      rolesSocketPath: ROLES_SOCKET,
      resolver: deps.resolver,
      sessionMgr: deps.sessionMgr,
      sendToHub: deps.sendToHub
    });

    expect(res.ok).toBe(true);
    expect(res.trace_id).toBeTruthy();
    expect(deps.sent.length).toBe(1);
    const msg = deps.sent[0];
    expect(msg.intent).toBe("run");
    expect(msg.target).toBe("agent-dispatcher");
    expect(msg.thread_id).toBe(CHATTER_THREAD_ID);
    expect(msg.payload.content).toContain("build X");
    expect(msg.reply_channel.channel).toBe("socket");
    expect(msg.reply_channel.socket_path).toBe(ROLES_SOCKET);
    expect(msg.suppress_reply).toBe(false);
  });

  it("registers the trace_id on the session manager before sending", async () => {
    const deps = makeDeps(root);
    const res = await dispatchCodingJob({
      args: { instruction: "x" },
      chatterThreadId: CHATTER_THREAD_ID,
      rolesSocketPath: ROLES_SOCKET,
      resolver: deps.resolver,
      sessionMgr: deps.sessionMgr,
      sendToHub: deps.sendToHub
    });
    expect(res.ok).toBe(true);
    const trace = deps.sessionMgr.getTrace(res.trace_id!);
    expect(trace?.purpose).toBe("job_dispatch");
  });

  it("accepts paths under sandbox root", async () => {
    const deps = makeDeps(root);
    const workspace = path.join(root, "workspace");
    const res = await dispatchCodingJob({
      args: { instruction: "x", workspace_path: workspace, taskspec_path: path.join(root, "spec.md") },
      chatterThreadId: CHATTER_THREAD_ID,
      rolesSocketPath: ROLES_SOCKET,
      resolver: deps.resolver,
      sessionMgr: deps.sessionMgr,
      sendToHub: deps.sendToHub
    });
    expect(res.ok).toBe(true);
  });

  it("rejects workspace_path outside sandbox root", async () => {
    const deps = makeDeps(root);
    const res = await dispatchCodingJob({
      args: { instruction: "x", workspace_path: "/etc" },
      chatterThreadId: CHATTER_THREAD_ID,
      rolesSocketPath: ROLES_SOCKET,
      resolver: deps.resolver,
      sessionMgr: deps.sessionMgr,
      sendToHub: deps.sendToHub
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/sandbox/i);
    expect(deps.sent.length).toBe(0);
  });

  it("rejects taskspec_path outside sandbox root", async () => {
    const deps = makeDeps(root);
    const res = await dispatchCodingJob({
      args: { instruction: "x", taskspec_path: "/etc/spec.md" },
      chatterThreadId: CHATTER_THREAD_ID,
      rolesSocketPath: ROLES_SOCKET,
      resolver: deps.resolver,
      sessionMgr: deps.sessionMgr,
      sendToHub: deps.sendToHub
    });
    expect(res.ok).toBe(false);
    expect(deps.sent.length).toBe(0);
  });

  it("rejects relative paths in path fields", async () => {
    const deps = makeDeps(root);
    const res = await dispatchCodingJob({
      args: { instruction: "x", workspace_path: "relative/x" },
      chatterThreadId: CHATTER_THREAD_ID,
      rolesSocketPath: ROLES_SOCKET,
      resolver: deps.resolver,
      sessionMgr: deps.sessionMgr,
      sendToHub: deps.sendToHub
    });
    expect(res.ok).toBe(false);
  });

  it("retains trace on transport-stall (hub overload) and returns transport_stall flag", async () => {
    const deps = makeDeps(root);
    const stallError = new Error("Request timed out");
    const sendToHub = async () => {
      throw stallError;
    };
    const res = await dispatchCodingJob({
      args: { instruction: "x" },
      chatterThreadId: CHATTER_THREAD_ID,
      rolesSocketPath: ROLES_SOCKET,
      resolver: deps.resolver,
      sessionMgr: deps.sessionMgr,
      sendToHub
    });
    expect(res.ok).toBe(false);
    expect(res.transport_stall).toBe(true);
    expect(res.trace_id).toBeTruthy();
    // Trace must still be registered for human / retry
    expect(deps.sessionMgr.getTrace(res.trace_id!)).not.toBe(null);
  });

  it("does NOT retain trace on non-transport error", async () => {
    const deps = makeDeps(root);
    const sendToHub = async () => {
      throw new Error("agent-dispatcher rejected payload: invalid taskspec");
    };
    const res = await dispatchCodingJob({
      args: { instruction: "x" },
      chatterThreadId: CHATTER_THREAD_ID,
      rolesSocketPath: ROLES_SOCKET,
      resolver: deps.resolver,
      sessionMgr: deps.sessionMgr,
      sendToHub
    });
    expect(res.ok).toBe(false);
    expect(res.transport_stall).toBe(false);
    expect(deps.sessionMgr.getTrace(res.trace_id!)).toBe(null);
  });
});

describe("isTransportStallError", () => {
  it.each([
    "hub overloaded",
    "Request timed out",
    "fetch failed",
    "Headers Timeout Error",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT"
  ])("recognizes transport-class message: %s", (msg) => {
    expect(isTransportStallError(new Error(msg))).toBe(true);
  });

  it("does not classify random errors as transport stalls", () => {
    expect(isTransportStallError(new Error("validation failed"))).toBe(false);
    expect(isTransportStallError(new Error("no such file"))).toBe(false);
  });
});
