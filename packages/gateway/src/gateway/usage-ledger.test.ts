import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { GatewayUsageLedger } from "./usage-ledger";

test("GatewayUsageLedger records request usage and aggregates by supplier", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-gateway-usage-"));
  const ledger = new GatewayUsageLedger(path.join(dir, "usage.jsonl"));

  try {
    await ledger.record({
      provider: "codex",
      model: "gpt-5.4-mini",
      surface: "direct-test",
      promptTokens: 7,
      completionTokens: 5,
      durationMs: 321,
      timestamp: "2026-06-20T00:00:00.000Z"
    });
    await ledger.record({
      provider: "claude",
      model: "claude-sonnet-4-6",
      surface: "anthropic-messages",
      promptTokens: 11,
      completionTokens: 13,
      durationMs: 700,
      timestamp: "2026-06-20T00:01:00.000Z"
    });
    await ledger.record({
      provider: "codex",
      model: "gpt-5.4-mini",
      surface: "openai-chat",
      promptTokens: 3,
      completionTokens: 2,
      durationMs: 111,
      timestamp: "2026-06-20T00:02:00.000Z"
    });

    const snapshot = ledger.snapshot();

    assert.deepEqual(snapshot.summary, [
      {
        provider: "codex",
        requests: 2,
        promptTokens: 10,
        completionTokens: 7,
        totalTokens: 17,
        averageDurationMs: 216,
        latestAt: "2026-06-20T00:02:00.000Z"
      },
      {
        provider: "claude",
        requests: 1,
        promptTokens: 11,
        completionTokens: 13,
        totalTokens: 24,
        averageDurationMs: 700,
        latestAt: "2026-06-20T00:01:00.000Z"
      }
    ]);
    assert.equal(snapshot.log.length, 3);
    assert.equal(snapshot.log[0]?.model, "gpt-5.4-mini");
    assert.equal(snapshot.log[0]?.totalTokens, 5);
    assert.equal(snapshot.log[0]?.durationMs, 111);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayUsageLedger reloads persisted usage and limits log rows", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-gateway-usage-"));
  const ledgerPath = path.join(dir, "usage.jsonl");

  try {
    const ledger = new GatewayUsageLedger(ledgerPath);
    await ledger.record({
      provider: "gemini",
      model: "gemini-2.5-pro",
      surface: "openai-chat",
      promptTokens: 1,
      completionTokens: 2,
      durationMs: 30,
      timestamp: "2026-06-20T00:00:00.000Z"
    });
    await ledger.record({
      provider: "gemini",
      model: "gemini-2.5-flash",
      surface: "openai-chat",
      promptTokens: 3,
      completionTokens: 4,
      durationMs: 40,
      timestamp: "2026-06-20T00:01:00.000Z"
    });

    const restored = new GatewayUsageLedger(ledgerPath);
    const snapshot = restored.snapshot({ limit: 1 });

    assert.equal(snapshot.log.length, 1);
    assert.equal(snapshot.log[0]?.model, "gemini-2.5-flash");
    assert.equal(snapshot.summary[0]?.requests, 2);
    assert.equal(snapshot.summary[0]?.totalTokens, 10);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
