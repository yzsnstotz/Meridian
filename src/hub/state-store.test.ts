import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { loadPersistedHubState } from "./state-store";

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

    assert.equal(loaded.version, 2);
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
