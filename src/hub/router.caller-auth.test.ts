import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { HubMessage, HubResult } from "../types";
import type { WireAuth } from "../shared/caller-wire";
import type { CallerRecord } from "./caller-registry";
import { InstanceRegistry } from "./registry";
import { HubRouter } from "./router";
import { buildPersistedHubState, savePersistedHubState } from "./state-store";

function baseMessage(overrides: Partial<HubMessage> = {}): HubMessage {
  return {
    trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
    thread_id: "thread-1",
    actor_id: "owner",
    intent: "list",
    target: "codex",
    payload: { content: "", attachments: [] },
    mode: "bridge",
    reply_channel: { channel: "socket", chat_id: "owner", socket_path: "/tmp/x.sock" },
    ...overrides
  };
}

function parseJsonPrefix<T>(content: string): T {
  const attachmentIndex = content.indexOf("\n\nAttached chat sessions:");
  const jsonContent = attachmentIndex >= 0 ? content.slice(0, attachmentIndex) : content;
  return JSON.parse(jsonContent) as T;
}

type TestCallerAuthority = "read" | "write" | "stateless_call" | "admin";

interface Harness {
  router: HubRouter;
  registry: InstanceRegistry;
  statePath: string;
  cleanup: () => void;
  mintCaller: (callerId: string, opts?: { kind?: "builtin" | "external"; revoked?: boolean; label?: string; authority?: TestCallerAuthority }) => string;
}

async function setupHarness(initialCallers: CallerRecord[] = []): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-caller-auth-"));
  const statePath = path.join(tmpDir, "state.json");
  savePersistedHubState(statePath, buildPersistedHubState(new Date().toISOString(), [], {}, {}, {}, initialCallers));
  const registry = new InstanceRegistry();
  const router = new HubRouter(registry, { statePath });
  await router.initialize();

  const mintCaller = (
    callerId: string,
    opts: { kind?: "builtin" | "external"; revoked?: boolean; label?: string; authority?: TestCallerAuthority } = {}
  ): string => {
    const registry = router.getCallerRegistry();
    if (!registry) throw new Error("registry_unavailable");
    if (opts.kind === "builtin") {
      const cleartextKey = crypto.randomBytes(16).toString("hex");
      registry.ensureBuiltin({
        caller_id: callerId,
        caller_label: opts.label ?? callerId,
        authority: opts.authority,
        deriveKey: () => cleartextKey
      });
      if (opts.revoked) {
        registry.revoke(callerId);
      }
      return cleartextKey;
    }
    const minted = registry.mint({
      caller_id: callerId,
      caller_label: opts.label ?? callerId,
      kind: "external",
      authority: opts.authority
    });
    if (opts.revoked) {
      registry.revoke(callerId);
    }
    return minted.cleartextKey;
  };

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };

  return { router, registry, statePath, cleanup, mintCaller };
}

test("authenticateCaller: missing auth → caller_required", async () => {
  const harness = await setupHarness();
  try {
    const result = await harness.router.route(baseMessage(), null);
    assert.equal(result.status, "error");
    assert.equal(result.content, "caller_required");
  } finally {
    harness.cleanup();
  }
});

test("authenticateCaller: unknown caller_id → caller_unknown", async () => {
  const harness = await setupHarness();
  try {
    const auth: WireAuth = { caller_id: "ghost", caller_key: "deadbeef" };
    const result = await harness.router.route(baseMessage(), auth);
    assert.equal(result.status, "error");
    assert.equal(result.content, "caller_unknown");
  } finally {
    harness.cleanup();
  }
});

test("authenticateCaller: revoked caller → caller_unknown", async () => {
  const harness = await setupHarness();
  try {
    const cleartextKey = harness.mintCaller("revoked-svc", { kind: "external" });
    harness.router.getCallerRegistry()?.revoke("revoked-svc");
    const result = await harness.router.route(
      baseMessage(),
      { caller_id: "revoked-svc", caller_key: cleartextKey }
    );
    assert.equal(result.status, "error");
    assert.equal(result.content, "caller_unknown");
  } finally {
    harness.cleanup();
  }
});

test("authenticateCaller: wrong key for known caller → caller_invalid", async () => {
  const harness = await setupHarness();
  try {
    harness.mintCaller("svc-a", { kind: "external" });
    const result = await harness.router.route(
      baseMessage(),
      { caller_id: "svc-a", caller_key: "00".repeat(32) }
    );
    assert.equal(result.status, "error");
    assert.equal(result.content, "caller_invalid");
  } finally {
    harness.cleanup();
  }
});

test("authenticateCaller: valid key → dispatch proceeds", async () => {
  const harness = await setupHarness();
  try {
    const cleartextKey = harness.mintCaller("svc-b", { kind: "external", label: "Service B" });
    const result = await harness.router.route(
      baseMessage({ intent: "list_callers", payload: { content: "", attachments: [] } }),
      { caller_id: "svc-b", caller_key: cleartextKey }
    );
    assert.equal(result.status, "success");
  } finally {
    harness.cleanup();
  }
});

test("authenticateCaller: spoofed caller_id in message body is overridden by registry → admin gate rejects non-admin", async () => {
  // Critical behavior: even if a non-admin caller body-spoofs `caller.caller_id = "meridian-admin"`,
  // the auth middleware injects the registry-authoritative id, so the admin gate rejects them.
  const harness = await setupHarness();
  try {
    const cleartextKey = harness.mintCaller("svc-spoof", { kind: "external", label: "Service Spoof" });
    const incoming = baseMessage({
      intent: "register_caller",
      payload: { content: JSON.stringify({ caller_id: "evil", caller_label: "Evil" }), attachments: [] }
    });
    // Client tries to spoof identity by setting message.caller.caller_id to admin.
    incoming.caller = { caller_id: "meridian-admin", caller_label: "Pretender" };
    const result = await harness.router.route(incoming, { caller_id: "svc-spoof", caller_key: cleartextKey });
    assert.equal(result.status, "error");
    assert.equal(result.content, "caller_not_authorized_for_intent");
  } finally {
    harness.cleanup();
  }
});

test("authenticateCaller: touchLastSeen runs once per successful auth", async () => {
  const harness = await setupHarness();
  try {
    const cleartextKey = harness.mintCaller("svc-c", { kind: "external" });
    const before = harness.router.getCallerRegistry()?.get("svc-c")?.last_seen_at ?? null;
    const result = await harness.router.route(
      baseMessage({ intent: "list_callers", payload: { content: "", attachments: [] } }),
      { caller_id: "svc-c", caller_key: cleartextKey }
    );
    assert.equal(result.status, "success");
    const after = harness.router.getCallerRegistry()?.get("svc-c")?.last_seen_at ?? null;
    assert.notEqual(before, after);
    assert.ok(after, "last_seen_at should be set after successful auth");
  } finally {
    harness.cleanup();
  }
});

test("admin gate: non-admin caller calling register_caller → caller_not_authorized_for_intent", async () => {
  const harness = await setupHarness();
  try {
    const cleartextKey = harness.mintCaller("svc-d", { kind: "external" });
    const result = await harness.router.route(
      baseMessage({
        intent: "register_caller",
        payload: { content: JSON.stringify({ caller_id: "x", caller_label: "X" }), attachments: [] }
      }),
      { caller_id: "svc-d", caller_key: cleartextKey }
    );
    assert.equal(result.status, "error");
    assert.equal(result.content, "caller_not_authorized_for_intent");
  } finally {
    harness.cleanup();
  }
});

test("authority gate: read caller can list but cannot spawn", async () => {
  const harness = await setupHarness();
  try {
    const cleartextKey = harness.mintCaller("read-svc", { kind: "external", authority: "read" });
    const listResult = await harness.router.route(
      baseMessage({ intent: "list", payload: { content: "", attachments: [] } }),
      { caller_id: "read-svc", caller_key: cleartextKey }
    );
    assert.notEqual(listResult.status, "error");

    const spawnResult = await harness.router.route(
      baseMessage({ intent: "spawn", payload: { content: "", attachments: [] }, target: "codex" }),
      { caller_id: "read-svc", caller_key: cleartextKey }
    );
    assert.equal(spawnResult.status, "error");
    assert.equal(spawnResult.content, "caller_not_authorized_for_intent");
  } finally {
    harness.cleanup();
  }
});

test("authority gate: stateless_call caller can spawn Codex stateless read-only but not bridge", async () => {
  const harness = await setupHarness();
  try {
    const cleartextKey = harness.mintCaller("stateless-svc", { kind: "external", authority: "stateless_call" });
    const statelessSpawn = await harness.router.route(
      baseMessage({
        intent: "spawn",
        payload: { content: "", attachments: [] },
        target: "codex",
        mode: "stateless_call"
      }),
      { caller_id: "stateless-svc", caller_key: cleartextKey }
    );
    assert.equal(statelessSpawn.status, "success");
    const body = parseJsonPrefix<{ instance: { mode: string; sandbox_mode: string; auto_approve: boolean } }>(
      statelessSpawn.content
    );
    assert.equal(body.instance.mode, "stateless_call");
    assert.equal(body.instance.sandbox_mode, "read-only");
    assert.equal(body.instance.auto_approve, false);

    const bridgeSpawn = await harness.router.route(
      baseMessage({
        intent: "spawn",
        payload: { content: "", attachments: [] },
        target: "codex",
        mode: "bridge"
      }),
      { caller_id: "stateless-svc", caller_key: cleartextKey }
    );
    assert.equal(bridgeSpawn.status, "error");
    assert.equal(bridgeSpawn.content, "caller_not_authorized_for_intent");
  } finally {
    harness.cleanup();
  }
});

test("authority gate: stateless_call caller cannot run bridge threads", async () => {
  const harness = await setupHarness();
  try {
    const cleartextKey = harness.mintCaller("stateless-run-svc", { kind: "external", authority: "stateless_call" });
    harness.registry.register({
      thread_id: "codex_bridge",
      agent_type: "codex",
      mode: "bridge",
      socket_path: "/tmp/agentapi-codex_bridge.sock",
      pid: 22,
      status: "idle",
      created_at: new Date().toISOString(),
      auto_approve: false
    });

    const blockedRun = await harness.router.route(
      baseMessage({
        intent: "run",
        thread_id: "codex_bridge",
        target: "codex_bridge",
        payload: { content: "should block", attachments: [] }
      }),
      { caller_id: "stateless-run-svc", caller_key: cleartextKey }
    );
    assert.equal(blockedRun.status, "error");
    assert.equal(blockedRun.content, "caller_not_authorized_for_intent");
  } finally {
    harness.cleanup();
  }
});

test("authority gate: admin authority can update caller authority", async () => {
  const harness = await setupHarness();
  try {
    const adminKey = harness.mintCaller("admin-svc", { kind: "external", authority: "admin" });
    harness.mintCaller("target-svc", { kind: "external", authority: "write" });
    const result = await harness.router.route(
      baseMessage({
        intent: "update_caller_authority",
        payload: { content: JSON.stringify({ caller_id: "target-svc", caller_authority: "read" }), attachments: [] }
      }),
      { caller_id: "admin-svc", caller_key: adminKey }
    );
    assert.equal(result.status, "success");
    assert.equal(harness.router.getCallerRegistry()?.get("target-svc")?.caller_authority, "read");
  } finally {
    harness.cleanup();
  }
});

test("admin gate: meridian-admin caller calling register_caller → success", async () => {
  const harness = await setupHarness();
  try {
    const adminKey = harness.mintCaller("meridian-admin", { kind: "builtin", label: "Meridian Admin" });
    const result = await harness.router.route(
      baseMessage({
        intent: "register_caller",
        payload: {
          content: JSON.stringify({ caller_id: "new-ext", caller_label: "New External" }),
          attachments: []
        }
      }),
      { caller_id: "meridian-admin", caller_key: adminKey }
    );
    assert.equal(result.status, "success");
    const parsed = JSON.parse(result.content) as { caller_id: string; caller_key: string };
    assert.equal(parsed.caller_id, "new-ext");
    assert.equal(typeof parsed.caller_key, "string");
    assert.equal(parsed.caller_key.length, 64);
  } finally {
    harness.cleanup();
  }
});

test("admin gate: register_caller accepts caller_authority at mint time", async () => {
  const harness = await setupHarness();
  try {
    const adminKey = harness.mintCaller("meridian-admin", { kind: "builtin", label: "Meridian Admin" });
    const result = await harness.router.route(
      baseMessage({
        intent: "register_caller",
        payload: {
          content: JSON.stringify({
            caller_id: "stateless-ext",
            caller_label: "Stateless External",
            caller_authority: "stateless_call"
          }),
          attachments: []
        }
      }),
      { caller_id: "meridian-admin", caller_key: adminKey }
    );
    assert.equal(result.status, "success");
    const parsed = JSON.parse(result.content) as { caller_id: string; caller_authority: string };
    assert.equal(parsed.caller_id, "stateless-ext");
    assert.equal(parsed.caller_authority, "stateless_call");
    assert.equal(harness.router.getCallerRegistry()?.get("stateless-ext")?.caller_authority, "stateless_call");
  } finally {
    harness.cleanup();
  }
});

test("admin gate: list_callers is allowed for any valid caller and strips key_hash", async () => {
  const harness = await setupHarness();
  try {
    const cleartextKey = harness.mintCaller("svc-e", { kind: "external", label: "Service E" });
    const result = await harness.router.route(
      baseMessage({ intent: "list_callers", payload: { content: "", attachments: [] } }),
      { caller_id: "svc-e", caller_key: cleartextKey }
    );
    assert.equal(result.status, "success");
    const body = JSON.parse(result.content) as { callers: Array<Record<string, unknown>>; bootstrap_key_set: boolean };
    assert.ok(Array.isArray(body.callers));
    assert.ok(body.callers.length >= 1);
    for (const entry of body.callers) {
      assert.equal(Object.prototype.hasOwnProperty.call(entry, "key_hash"), false, "key_hash must be stripped");
    }
    assert.equal(typeof body.bootstrap_key_set, "boolean");
  } finally {
    harness.cleanup();
  }
});

test("admin gate: rotate_caller_key by admin returns new cleartext", async () => {
  const harness = await setupHarness();
  try {
    const adminKey = harness.mintCaller("meridian-admin", { kind: "builtin", label: "Meridian Admin" });
    harness.mintCaller("rotate-target", { kind: "external" });
    const result = await harness.router.route(
      baseMessage({
        intent: "rotate_caller_key",
        payload: { content: JSON.stringify({ caller_id: "rotate-target" }), attachments: [] }
      }),
      { caller_id: "meridian-admin", caller_key: adminKey }
    );
    assert.equal(result.status, "success");
    const parsed = JSON.parse(result.content) as { caller_key: string };
    assert.equal(typeof parsed.caller_key, "string");
    assert.equal(parsed.caller_key.length, 64);
  } finally {
    harness.cleanup();
  }
});

test("admin gate: unregister_caller by admin returns revoked_at", async () => {
  const harness = await setupHarness();
  try {
    const adminKey = harness.mintCaller("meridian-admin", { kind: "builtin", label: "Meridian Admin" });
    harness.mintCaller("doomed", { kind: "external" });
    const result = await harness.router.route(
      baseMessage({
        intent: "unregister_caller",
        payload: { content: JSON.stringify({ caller_id: "doomed" }), attachments: [] }
      }),
      { caller_id: "meridian-admin", caller_key: adminKey }
    );
    assert.equal(result.status, "success");
    const parsed = JSON.parse(result.content) as { revoked_at: string };
    assert.equal(typeof parsed.revoked_at, "string");
    const status = harness.router.getCallerRegistry()?.get("doomed")?.revoked_at ?? null;
    assert.ok(status, "registry should record revoked_at");
  } finally {
    harness.cleanup();
  }
});

test("legacy bypass: route() called without auth argument skips the auth middleware", async () => {
  // Existing tests construct a HubRouter and call route(message) without an auth argument.
  // That path must remain functional so non-auth router tests aren't broken by the middleware.
  const harness = await setupHarness();
  try {
    const result: HubResult = await harness.router.route(baseMessage({ intent: "list_callers", payload: { content: "", attachments: [] } }));
    assert.equal(result.status, "success");
  } finally {
    harness.cleanup();
  }
});

test("terminal_input: history entry carries caller_id and caller_label from message.caller", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "cursor_01",
    agent_type: "cursor",
    mode: "bridge",
    socket_path: "http://127.0.0.1:63011",
    pid: 22,
    status: "waiting",
    created_at: new Date().toISOString()
  });

  const fakeInstanceManager = {
    rehydrateFromState: async () => ({ restored_thread_ids: [], pruned_thread_ids: [] }),
    snapshotState: () => ({ version: 1, updated_at: new Date().toISOString(), instances: registry.list(), session_bindings: {} }),
    sendTerminalInput: () => "Sent terminal input to cursor_01.",
    getAttachedThread: () => "cursor_01",
    list: () => registry.list(),
    getThreadAttachment: () => ({ sessions: [], interface_id: null }),
    isThreadAttachableBySession: () => true
  };

  const router = new HubRouter(registry, {
    instanceManager: fakeInstanceManager as never,
    statePath: "/tmp/meridian-caller-history-test.json"
  });

  const caller = { caller_id: "meridian-web", caller_label: "Meridian Web" };
  await router.route(
    baseMessage({
      intent: "terminal_input",
      thread_id: "cursor_01",
      target: "cursor_01",
      payload: { content: "run", attachments: [] },
      reply_channel: { channel: "socket", chat_id: "owner", socket_path: "/tmp/x.sock" },
      caller
    })
  );

  const history = router.getConversationHistoryForThread("cursor_01");
  assert.equal(history.length, 1);
  assert.equal(history[0]?.event_kind, "terminal_input");
  assert.equal(history[0]?.caller_id, "meridian-web");
  assert.equal(history[0]?.caller_label, "Meridian Web");
});

test("terminal_input: history entry has null caller fields when message.caller is undefined", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "cursor_02",
    agent_type: "cursor",
    mode: "bridge",
    socket_path: "http://127.0.0.1:63012",
    pid: 23,
    status: "waiting",
    created_at: new Date().toISOString()
  });

  const fakeInstanceManager = {
    rehydrateFromState: async () => ({ restored_thread_ids: [], pruned_thread_ids: [] }),
    snapshotState: () => ({ version: 1, updated_at: new Date().toISOString(), instances: registry.list(), session_bindings: {} }),
    sendTerminalInput: () => "Sent terminal input to cursor_02.",
    getAttachedThread: () => "cursor_02",
    list: () => registry.list(),
    getThreadAttachment: () => ({ sessions: [], interface_id: null }),
    isThreadAttachableBySession: () => true
  };

  const router = new HubRouter(registry, {
    instanceManager: fakeInstanceManager as never,
    statePath: "/tmp/meridian-caller-history-test2.json"
  });

  await router.route(
    baseMessage({
      intent: "terminal_input",
      thread_id: "cursor_02",
      target: "cursor_02",
      payload: { content: "run", attachments: [] },
      reply_channel: { channel: "socket", chat_id: "owner", socket_path: "/tmp/x.sock" }
    })
  );

  const history = router.getConversationHistoryForThread("cursor_02");
  assert.equal(history.length, 1);
  assert.equal(history[0]?.caller_id, null);
  assert.equal(history[0]?.caller_label, null);
});

test("terminal_input: last_caller and last_caller_at updated on registry instance", async () => {
  const registry = new InstanceRegistry();
  const before = new Date();
  registry.register({
    thread_id: "cursor_03",
    agent_type: "cursor",
    mode: "bridge",
    socket_path: "http://127.0.0.1:63013",
    pid: 24,
    status: "waiting",
    created_at: before.toISOString()
  });

  const fakeInstanceManager = {
    rehydrateFromState: async () => ({ restored_thread_ids: [], pruned_thread_ids: [] }),
    snapshotState: () => ({ version: 1, updated_at: new Date().toISOString(), instances: registry.list(), session_bindings: {} }),
    sendTerminalInput: () => "Sent terminal input to cursor_03.",
    getAttachedThread: () => "cursor_03",
    list: () => registry.list(),
    getThreadAttachment: () => ({ sessions: [], interface_id: null }),
    isThreadAttachableBySession: () => true
  };

  const router = new HubRouter(registry, {
    instanceManager: fakeInstanceManager as never,
    statePath: "/tmp/meridian-caller-last-caller-test.json"
  });

  const caller = { caller_id: "meridian-cli", caller_label: "Meridian CLI" };
  await router.route(
    baseMessage({
      intent: "terminal_input",
      thread_id: "cursor_03",
      target: "cursor_03",
      payload: { content: "run", attachments: [] },
      reply_channel: { channel: "socket", chat_id: "owner", socket_path: "/tmp/x.sock" },
      caller
    })
  );

  const instance = registry.get("cursor_03");
  assert.equal(instance?.last_caller?.caller_id, "meridian-cli");
  assert.equal(instance?.last_caller?.caller_label, "Meridian CLI");
  assert.ok(instance?.last_caller_at, "last_caller_at should be set");
  const lastCallerAt = new Date(instance!.last_caller_at!);
  assert.ok(lastCallerAt.getTime() >= before.getTime(), "last_caller_at should be >= spawn time");
});

test("detail: service self-probe backfills missing legacy caller attribution", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_legacy",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_legacy.sock",
    pid: 42,
    status: "running",
    created_at: new Date().toISOString()
  });

  const fakeInstanceManager = {
    rehydrateFromState: async () => ({ restored_thread_ids: [], pruned_thread_ids: [] }),
    snapshotState: () => ({ version: 1, updated_at: new Date().toISOString(), instances: registry.list(), session_bindings: {} }),
    getAttachedThread: () => null,
    list: () => registry.list(),
    getThreadAttachment: () => ({ sessions: [], interface_id: null }),
    isThreadAttachableBySession: () => true
  };

  const router = new HubRouter(registry, {
    instanceManager: fakeInstanceManager as never,
    statePath: "/tmp/meridian-caller-detail-adoption-test.json"
  });

  const caller = { caller_id: "meridian-roles", caller_label: "Meridian-Roles" };
  await router.route(
    baseMessage({
      intent: "detail",
      thread_id: "codex_legacy",
      target: "codex_legacy",
      actor_id: "service:meridian-roles",
      caller
    })
  );

  const instance = registry.get("codex_legacy");
  assert.equal(instance?.last_caller?.caller_id, "meridian-roles");
  assert.equal(instance?.last_caller?.caller_label, "Meridian-Roles");
  assert.equal(instance?.spawned_by?.caller_id, "meridian-roles");
  assert.equal(instance?.spawned_by?.caller_label, "Meridian-Roles");
});

test("detail: non-service caller does not claim missing spawned_by", async () => {
  const registry = new InstanceRegistry();
  registry.register({
    thread_id: "codex_legacy",
    agent_type: "codex",
    mode: "bridge",
    socket_path: "/tmp/agentapi-codex_legacy.sock",
    pid: 43,
    status: "running",
    created_at: new Date().toISOString()
  });

  const fakeInstanceManager = {
    rehydrateFromState: async () => ({ restored_thread_ids: [], pruned_thread_ids: [] }),
    snapshotState: () => ({ version: 1, updated_at: new Date().toISOString(), instances: registry.list(), session_bindings: {} }),
    getAttachedThread: () => null,
    list: () => registry.list(),
    getThreadAttachment: () => ({ sessions: [], interface_id: null }),
    isThreadAttachableBySession: () => true
  };

  const router = new HubRouter(registry, {
    instanceManager: fakeInstanceManager as never,
    statePath: "/tmp/meridian-caller-detail-nonservice-test.json"
  });

  const caller = { caller_id: "meridian-web", caller_label: "Meridian Web" };
  await router.route(
    baseMessage({
      intent: "detail",
      thread_id: "codex_legacy",
      target: "codex_legacy",
      actor_id: "web:browser-session",
      caller
    })
  );

  const instance = registry.get("codex_legacy");
  assert.equal(instance?.last_caller?.caller_id, "meridian-web");
  assert.equal(instance?.spawned_by, undefined);
});
