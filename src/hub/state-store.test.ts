import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";

import {
  buildPersistedHubState,
  loadPersistedHubState,
  migrateLegacyConversationHistoryV2ToV3,
  type CallerRecord
} from "./state-store";

test("loadPersistedHubState preserves migrated approval prompts alongside terminal input and final reply", () => {
  const statePath = `/tmp/meridian-state-store-${process.pid}-${Date.now()}.json`;
  const nowIso = new Date().toISOString();
  const traceId = "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8";

  fs.writeFileSync(
    statePath,
    JSON.stringify(
      {
        version: 1,
        updated_at: nowIso,
        instances: [],
        session_bindings: {},
        push_subscriptions: {},
        conversation_history: {
          approval_legacy: [
            {
              id: "approval",
              type: "agent",
              content: "Waiting for approval...\nRun this command?\n1. Allow once\n2. Allow for this session\n3. No, suggest changes",
              details_text: "",
              raw_content: "Waiting for approval...\nRun this command?\n1. Allow once\n2. Allow for this session\n3. No, suggest changes",
              trace_id: traceId,
              timestamp: "2026-03-25T00:00:00.000Z"
            },
            {
              id: "resolve",
              type: "user",
              content: "allow",
              details_text: "",
              raw_content: "",
              trace_id: traceId,
              timestamp: "2026-03-25T00:00:01.000Z"
            },
            {
              id: "final",
              type: "agent",
              content: "done",
              details_text: "done",
              raw_content: "done",
              trace_id: traceId,
              timestamp: "2026-03-25T00:00:02.000Z"
            }
          ]
        }
      },
      null,
      2
    ),
    "utf8"
  );

  try {
    const loaded = loadPersistedHubState(statePath, nowIso);
    const history = loaded.conversation_history?.approval_legacy ?? [];

    assert.equal(loaded.version, 3);
    assert.equal(history.length, 3);
    assert.deepEqual(
      history.map((entry) => entry.event_kind),
      ["approval", "terminal_input", "final_reply"]
    );
    assert.match(history[0]?.content ?? "", /^Waiting for approval\.\.\./);
    assert.equal(history[1]?.content, "allow");
    assert.equal(history[2]?.content, "done");
  } finally {
    fs.rmSync(statePath, { force: true });
  }
});

test("loadPersistedHubState coalesces migrated approval prompts using the narrowed replace_key", () => {
  const statePath = `/tmp/meridian-state-store-${process.pid}-${Date.now()}-approval.json`;
  const nowIso = new Date().toISOString();
  const approvalTraceId = "4f461d95-0157-4f90-bb4d-a63f2bfb1ed8";

  fs.writeFileSync(
    statePath,
    JSON.stringify(
      {
        version: 1,
        updated_at: nowIso,
        instances: [],
        session_bindings: {},
        push_subscriptions: {},
        conversation_history: {
          mixed_legacy: [
            {
              id: "approval-1",
              type: "agent",
              content: "Waiting for approval...\nRun this command?\n1. Allow once\n2. Allow for this session\n3. No, suggest changes",
              details_text: "",
              raw_content: "Waiting for approval...\nRun this command?\n1. Allow once\n2. Allow for this session\n3. No, suggest changes",
              trace_id: approvalTraceId,
              timestamp: "2026-03-25T00:00:00.000Z"
            },
            {
              id: "approval-2",
              type: "agent",
              content: "Waiting for approval...\nRun this command?\n1. Allow once\n2. Allow for this session\n3. No, suggest changes",
              details_text: "",
              raw_content: "Waiting for approval...\nRun this command?\n1. Allow once\n2. Allow for this session\n3. No, suggest changes",
              trace_id: approvalTraceId,
              timestamp: "2026-03-25T00:00:01.000Z"
            }
          ]
        }
      },
      null,
      2
    ),
    "utf8"
  );

  try {
    const loaded = loadPersistedHubState(statePath, nowIso);
    const history = loaded.conversation_history?.mixed_legacy ?? [];

    assert.equal(loaded.version, 3);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.event_kind, "approval");
    assert.equal(history[0]?.replace_key, `${approvalTraceId}:approval`);
    assert.match(history[0]?.content ?? "", /^Waiting for approval\.\.\./);
  } finally {
    fs.rmSync(statePath, { force: true });
  }
});

test("migrateLegacyConversationHistoryV2ToV3 fills caller fields and adds empty callers array", () => {
  const nowIso = "2026-04-10T12:00:00.000Z";
  const traceId = "8a461d95-0157-4f90-bb4d-a63f2bfb1ed8";

  const v2State = {
    version: 2 as const,
    updated_at: nowIso,
    instances: [],
    session_bindings: {},
    push_subscriptions: {},
    conversation_history: {
      thread_a: [
        {
          id: "evt-1",
          sequence: 1,
          event_kind: "user_send" as const,
          source: "user",
          content: "hello",
          details_text: "",
          raw_content: "hello",
          trace_id: traceId,
          timestamp: nowIso,
          replace_key: null
        }
      ]
    }
  };

  const v3 = migrateLegacyConversationHistoryV2ToV3(v2State);

  assert.equal(v3.version, 3);
  assert.deepEqual(v3.callers, []);
  const entries = v3.conversation_history?.thread_a ?? [];
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.caller_id, null);
  assert.equal(entries[0]?.caller_label, null);
  assert.equal(entries[0]?.content, "hello");
});

test("v3 fixture with populated caller fields round-trips through schema unchanged", () => {
  const nowIso = "2026-04-11T09:00:00.000Z";
  const traceId = "9b561d95-0157-4f90-bb4d-a63f2bfb1ed8";

  const callers: CallerRecord[] = [
    {
      caller_id: "meridian-web",
      caller_label: "Meridian Web",
      caller_kind: "builtin",
      caller_authority: "write",
      key_hash: "a".repeat(64),
      created_at: nowIso,
      last_seen_at: nowIso,
      revoked_at: null
    }
  ];

  const built = buildPersistedHubState(
    nowIso,
    [],
    {},
    {},
    {
      thread_a: [
        {
          id: "evt-1",
          sequence: 1,
          event_kind: "user_send",
          source: "user",
          content: "hi",
          details_text: "",
          raw_content: "hi",
          trace_id: traceId,
          timestamp: nowIso,
          replace_key: null,
          caller_id: "meridian-web",
          caller_label: "Meridian Web"
        }
      ]
    },
    callers
  );

  const roundTripped = JSON.parse(JSON.stringify(built));
  const reparsed = migrateLegacyConversationHistoryV2ToV3(roundTripped);

  assert.deepEqual(reparsed, built);
  assert.equal(reparsed.callers?.[0]?.caller_id, "meridian-web");
  assert.equal(reparsed.conversation_history?.thread_a?.[0]?.caller_id, "meridian-web");
  assert.equal(reparsed.conversation_history?.thread_a?.[0]?.caller_label, "Meridian Web");
});

test("migrateLegacyConversationHistoryV2ToV3 is idempotent on a v3 state", () => {
  const nowIso = "2026-04-12T09:00:00.000Z";
  const built = buildPersistedHubState(
    nowIso,
    [],
    {},
    {},
    {},
    [
      {
        caller_id: "meridian-cli",
        caller_label: "Meridian CLI",
        caller_kind: "builtin",
        caller_authority: "write",
        key_hash: "b".repeat(64),
        created_at: nowIso,
        last_seen_at: null,
        revoked_at: null
      }
    ]
  );

  const once = migrateLegacyConversationHistoryV2ToV3(built);
  const twice = migrateLegacyConversationHistoryV2ToV3(once);

  assert.deepEqual(once, built);
  assert.deepEqual(twice, once);
});

test("MERIDIAN_CALLER_KEYS legacy import seeds external callers once and is a no-op on second load", () => {
  const statePath = `/tmp/meridian-state-store-${process.pid}-${Date.now()}-callers.json`;
  const nowIso = "2026-04-13T09:00:00.000Z";
  const previousEnv = process.env.MERIDIAN_CALLER_KEYS;
  process.env.MERIDIAN_CALLER_KEYS = JSON.stringify([
    { caller_id: "foo", caller_label: "Foo", caller_key: "deadbeefcafef00d" }
  ]);
  const expectedHash = crypto
    .createHash("sha256")
    .update("deadbeefcafef00d" + "foo")
    .digest("hex");

  try {
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 3,
        updated_at: nowIso,
        instances: [],
        session_bindings: {},
        push_subscriptions: {},
        conversation_history: {},
        callers: []
      }),
      "utf8"
    );

    const firstLoad = loadPersistedHubState(statePath, nowIso);
    assert.equal(firstLoad.callers?.length, 1);
    assert.equal(firstLoad.callers?.[0]?.caller_id, "foo");
    assert.equal(firstLoad.callers?.[0]?.caller_label, "Foo");
    assert.equal(firstLoad.callers?.[0]?.caller_kind, "external");
    assert.equal(firstLoad.callers?.[0]?.key_hash, expectedHash);
    assert.equal(firstLoad.callers?.[0]?.revoked_at, null);

    // Persisted to disk so the env var can never re-seed (or un-revoke) on reboot.
    const onDisk = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(onDisk.callers.length, 1);
    assert.equal(onDisk.callers[0].caller_id, "foo");

    // Simulate operator revoking the caller — env var still set.
    const revokedAt = "2026-04-14T09:00:00.000Z";
    onDisk.callers[0].revoked_at = revokedAt;
    fs.writeFileSync(statePath, JSON.stringify(onDisk), "utf8");

    const secondLoad = loadPersistedHubState(statePath, nowIso);
    assert.equal(secondLoad.callers?.length, 1);
    assert.equal(secondLoad.callers?.[0]?.revoked_at, revokedAt, "revoked caller must remain revoked across boots");
  } finally {
    if (previousEnv === undefined) {
      delete process.env.MERIDIAN_CALLER_KEYS;
    } else {
      process.env.MERIDIAN_CALLER_KEYS = previousEnv;
    }
    fs.rmSync(statePath, { force: true });
  }
});
