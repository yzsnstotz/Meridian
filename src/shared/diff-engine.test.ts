import assert from "node:assert/strict";
import { test } from "node:test";

import { DiffEngine } from "./diff-engine";

test("DiffEngine returns incremental deltas for continuous snapshots", () => {
  const engine = new DiffEngine();

  assert.equal(engine.diff("trace-1", "hello"), "hello");
  assert.equal(engine.diff("trace-1", "hello world"), " world");
  assert.equal(engine.diff("trace-1", "hello world!"), "!");
});

test("DiffEngine returns the full snapshot when continuity is broken", () => {
  const engine = new DiffEngine();

  assert.equal(engine.diff("trace-1", "hello world"), "hello world");
  assert.equal(engine.diff("trace-1", "reset output"), "reset output");
});

test("DiffEngine returns an empty delta for identical snapshots", () => {
  const engine = new DiffEngine();

  assert.equal(engine.diff("trace-1", "same output"), "same output");
  assert.equal(engine.diff("trace-1", "same output"), "");
});

test("DiffEngine clear resets stored state for a trace", () => {
  const engine = new DiffEngine();

  assert.equal(engine.diff("trace-1", "hello"), "hello");
  engine.clear("trace-1");
  assert.equal(engine.diff("trace-1", "hello again"), "hello again");
});

test("DiffEngine tracks multiple traceIds independently", () => {
  const engine = new DiffEngine();

  assert.equal(engine.diff("trace-1", "alpha"), "alpha");
  assert.equal(engine.diff("trace-2", "beta"), "beta");
  assert.equal(engine.diff("trace-1", "alphabet"), "bet");
  assert.equal(engine.diff("trace-2", "beta gamma"), " gamma");
});
