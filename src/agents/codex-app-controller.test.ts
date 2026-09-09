import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppControllerDuties } from "./codex-app-controller";
import { AppHandoffQueue } from "./codex-app-queue";

test("controller duties deliver first, never mutate requests or claim an audit completion", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "meridian-controller-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const queue = new AppHandoffQueue(directory);
  queue.create({ id: "new-downstream", workerId: "consumer-a", cwd: "/private", prompt: "private task" });
  queue.create({ id: "repair", workerId: "consumer-b", cwd: "/private", prompt: "private feedback" });
  queue.claim("repair", "native-controller");
  queue.submit("repair", "native-controller");
  const before = queue.list();
  const duty = new AppControllerDuties(queue, () => new Date("2026-09-09T01:00:00.000Z"));
  const scan = duty.check("native-controller");
  assert.equal(scan.audit_due, true);
  assert.deepEqual(scan.requests.map((r: any) => [r.request_id, r.action]), [["new-downstream", "submit_native"], ["repair", "reconcile_submission"]]);
  assert.doesNotMatch(JSON.stringify(scan), /private task|private feedback|prompt|receipt|cwd/);
  assert.deepEqual(queue.list(), before, "a scan must not refresh worker progress or queue state");
  assert.equal(scan.last_audit_completed_at, null);
  assert.equal(new AppControllerDuties(queue).check("native-controller").last_audit_completed_at, null);
  queue.bindThread("repair", "native-controller", "01a07727-ac38-7c23-8ef3-4bc90f594b9a");
  queue.started("repair", "native-controller", "exact-turn");
  assert.equal(duty.check("native-controller").requests.find(r => r.request_id === "repair")?.action, "observe_exact_turn");
  queue.cancel("repair");
  assert.equal(duty.check("native-controller").requests.find(r => r.request_id === "repair")?.action, "reconcile_cancellation");
  assert.equal(duty.check("another-controller").requests.find(r => r.request_id === "repair")?.action, "other_controller");
});

test("hourly audit checkpoint survives reopen and checks do not move it", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "meridian-audit-checkpoint-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const queue = new AppHandoffQueue(directory);
  const at = "2026-09-09T01:00:00.000Z";
  new AppControllerDuties(queue, () => new Date(at)).auditComplete("native-controller");
  const recent = new AppControllerDuties(queue, () => new Date("2026-09-09T01:59:59.000Z")).check("native-controller");
  assert.equal(recent.audit_due, false);
  assert.equal(recent.last_audit_completed_at, at);
  const due = new AppControllerDuties(queue, () => new Date("2026-09-09T02:00:00.000Z")).check("native-controller");
  assert.equal(due.audit_due, true);
  assert.equal(due.last_audit_completed_at, at);
  assert.equal(queue.list(true).length, 0, "checkpoints are not queue records");
  const filename = path.join(directory, ".controllers", "native-controller.json");
  assert.equal(statSync(filename).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(filename, "utf8")).lastAuditCompletedAt, at);
  writeFileSync(filename, "broken");
  assert.throws(() => new AppControllerDuties(queue).check("native-controller"), /JSON/);
  assert.throws(() => new AppControllerDuties(queue).check("../escape"), /Invalid/);
});

test("concurrent native checks preserve the completed audit and never submit requests", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "meridian-controller-concurrent-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const queue = new AppHandoffQueue(directory);
  const at = "2026-09-09T01:00:00.000Z";
  new AppControllerDuties(queue, () => new Date(at)).auditComplete("native-controller");
  queue.create({ id: "still-pending", workerId: "unrelated-owner", cwd: "/private", prompt: "private" });
  const before = queue.list();
  const results = await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath,
    ["--import", "tsx", path.join(__dirname, "codex-app-controller.ts"), "check", "native-controller"],
    { env: { ...process.env, MERIDIAN_CODEX_APP_QUEUE_DIR: directory } })));
  for (const result of results) assert.equal(JSON.parse(result.stdout).last_audit_completed_at, at);
  assert.deepEqual(queue.list(), before);
  assert.equal(new AppControllerDuties(queue).check("native-controller").last_audit_completed_at, at);
});
