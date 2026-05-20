import { test } from "node:test";
import assert from "node:assert/strict";
import { HubMessageSchema, AgentInstanceSchema } from "./types";

test("HubMessage spawn payload accepts optional credential_id", () => {
  const parsed = HubMessageSchema.parse({
    trace_id: "00000000-0000-4000-8000-000000000010",
    thread_id: "t1",
    actor_id: "a1",
    intent: "spawn",
    target: "codex",
    mode: "stateless_call",
    payload: {
      content: "",
      attachments: [],
      credential_id: "cred-xyz"
    },
    reply_channel: { channel: "socket", chat_id: "c1" }
  });
  assert.equal((parsed.payload as any).credential_id, "cred-xyz");
});

test("HubMessage spawn payload remains valid without credential_id (backwards compat)", () => {
  const parsed = HubMessageSchema.parse({
    trace_id: "00000000-0000-4000-8000-000000000010",
    thread_id: "t1",
    actor_id: "a1",
    intent: "spawn",
    target: "codex",
    mode: "stateless_call",
    payload: { content: "", attachments: [] },
    reply_channel: { channel: "socket", chat_id: "c1" }
  });
  assert.equal((parsed.payload as any).credential_id, undefined);
});

test("AgentInstanceSchema accepts credential_id and defaults to null", () => {
  // Use minimum fields required to construct a valid instance.
  // First, dump the schema's required field list — read AgentInstanceSchema in src/types.ts
  // to construct a valid baseline object below. If the schema requires additional fields,
  // add them here.
  const baseline: any = {
    thread_id: "t1",
    agent_type: "codex",
    mode: "stateless_call",
    pid: 1234,
    socket_path: "/tmp/x",
    status: "running",
    created_at: "2026-05-19T00:00:00.000Z"
  };
  // First parse-attempt — add fields as required by validation errors
  const result = AgentInstanceSchema.safeParse(baseline);
  if (!result.success) {
    throw new Error("Update test baseline to include fields: " + JSON.stringify(result.error.flatten().fieldErrors));
  }
  assert.equal(result.data.credential_id, null);
});

test("AgentInstanceSchema accepts an explicit credential_id", () => {
  const baseline: any = {
    thread_id: "t1",
    agent_type: "codex",
    mode: "stateless_call",
    pid: 1234,
    socket_path: "/tmp/x",
    status: "running",
    created_at: "2026-05-19T00:00:00.000Z",
    credential_id: "cred-xyz"
  };
  const result = AgentInstanceSchema.safeParse(baseline);
  if (!result.success) {
    throw new Error("Schema issue: " + JSON.stringify(result.error.flatten().fieldErrors));
  }
  assert.equal(result.data.credential_id, "cred-xyz");
});
