import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { assertDisposableStorageConfig, verifyDisposableStorageConfig } from "./codex-permissions";

const scratch = "/private/tmp/meridian-validation-fixture/scratch";
const valid = () => ({ sandbox_mode: null, sandbox_workspace_write: null, profile: null,
  approval_policy: "never", default_permissions: "meridian-validation-fixture",
  permissions: { "meridian-validation-fixture": { extends: ":read-only", workspace_roots: null,
    filesystem: { glob_scan_max_depth: null, [scratch]: "write" }, network: { enabled: false } } } });
test("effective disposable policy accepts exactly the readonly-derived scratch grant", () => {
  assert.doesNotThrow(() => assertDisposableStorageConfig(valid(), scratch));
});

test("public permission preflight reads effective config without creating a thread and closes its child", async () => {
  const methods: string[] = [];
  let ownershipTransferred = false;
  let killed = false;
  const fake = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: null as unknown as Writable, kill: () => { killed = true; queueMicrotask(() => fake.emit("close", 0)); return true; } });
  fake.stdin = new Writable({ write(chunk, _encoding, callback) {
    const message = JSON.parse(chunk.toString()); methods.push(message.method);
    if (message.id) queueMicrotask(() => fake.stdout.write(JSON.stringify({ id: message.id,
      result: message.id === 2 ? { config: valid() } : {} }) + "\n"));
    callback();
  } });
  await verifyDisposableStorageConfig("codex", ["exec", "-c", "approval_policy=\"never\"", "--json"], "/tmp", {}, scratch,
    ((command: string, args: string[]) => {
      assert.equal(command, "codex"); assert.deepEqual(args, ["app-server", "-c", "approval_policy=\"never\""]);
      return fake;
    }) as never, 5_000, child => { assert.equal(child, fake); ownershipTransferred = true; });
  assert.deepEqual(methods, ["initialize", "initialized", "config/read"]);
  assert.equal(killed, true);
  assert.equal(ownershipTransferred, true);
});

test("public permission preflight fails closed on timeout and early process termination", async () => {
  for (const early of [false, true]) {
    let killed = false;
    const fake = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      kill: () => { killed = true; queueMicrotask(() => fake.emit("close", 1)); return true; } });
    const promise = verifyDisposableStorageConfig("codex", ["exec"], "/tmp", {}, scratch,
      (() => { if (early) queueMicrotask(() => fake.emit("close", 1)); return fake; }) as never, 20);
    await assert.rejects(promise, /timed out|without a response/);
    if (!early) assert.equal(killed, true);
  }
});
test("effective disposable policy rejects legacy selection, extra grants and uncertain responses", () => {
  for (const sandbox_mode of [undefined, "read-only", "workspace-write", "danger-full-access"]) {
    assert.throws(() => assertDisposableStorageConfig({ ...valid(), sandbox_mode }, scratch), /legacy|uncertain/);
  }
  for (const field of ["default_permissions", "approval_policy", "profile"]) {
    assert.throws(() => assertDisposableStorageConfig({ ...valid(), [field]: "unexpected" }, scratch));
  }
  const extra = valid();
  Object.assign(extra.permissions["meridian-validation-fixture"].filesystem, { "/private/tmp": "write" });
  assert.throws(() => assertDisposableStorageConfig(extra, scratch), /exact/);
  const network = valid(); network.permissions["meridian-validation-fixture"].network.enabled = true;
  assert.throws(() => assertDisposableStorageConfig(network, scratch), /network/);
  assert.throws(() => assertDisposableStorageConfig(null, scratch));
});
