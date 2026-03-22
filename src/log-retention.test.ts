import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { collectLogInventory, enforceLogRetention } from "./log-retention";

test("collectLogInventory returns recursive log files sorted by size", async () => {
  const logDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-log-inventory-"));

  try {
    await fs.promises.mkdir(path.join(logDir, "GUI"), { recursive: true });
    await fs.promises.writeFile(path.join(logDir, "hub.log"), "1234567890");
    await fs.promises.writeFile(path.join(logDir, "GUI", "gui-pane-codex_01.log"), "1234");

    const inventory = await collectLogInventory(logDir, new Date("2026-03-23T00:00:00.000Z"));

    assert.equal(inventory.root, logDir);
    assert.equal(inventory.total_bytes, 14);
    assert.deepEqual(
      inventory.files.map((entry) => entry.path),
      ["hub.log", "GUI/gui-pane-codex_01.log"]
    );
  } finally {
    await fs.promises.rm(logDir, { recursive: true, force: true });
  }
});

test("enforceLogRetention trims oversized active logs and removes expired session logs", async () => {
  const logDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meridian-log-retention-"));
  const oversizedActive = path.join(logDir, "hub.log");
  const expiredSession = path.join(logDir, "pane-codex_01.log");

  try {
    await fs.promises.writeFile(oversizedActive, `${"a".repeat(64)}\n${"b".repeat(64)}\n`);
    await fs.promises.writeFile(expiredSession, "old-session-log\n");
    const oldDate = new Date("2026-03-01T00:00:00.000Z");
    await fs.promises.utimes(expiredSession, oldDate, oldDate);

    const result = await enforceLogRetention({
      logDir,
      activeFileMaxBytes: 80,
      activeFileKeepBytes: 40,
      sessionFileMaxBytes: 1024,
      sessionFileKeepBytes: 128,
      sessionFileMaxAgeHours: 24,
      now: () => new Date("2026-03-23T00:00:00.000Z")
    });

    assert.ok(result.trimmed.includes("hub.log"));
    assert.ok(result.removed.includes("pane-codex_01.log"));
    const trimmedContent = await fs.promises.readFile(oversizedActive, "utf8");
    assert.match(trimmedContent, /b+/);
    assert.equal(await fs.promises.stat(oversizedActive).then((stats) => stats.size < 80), true);
    await assert.rejects(fs.promises.stat(expiredSession));
  } finally {
    await fs.promises.rm(logDir, { recursive: true, force: true });
  }
});
