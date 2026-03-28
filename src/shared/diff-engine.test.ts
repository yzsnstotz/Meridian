import assert from "node:assert/strict";
import { test } from "node:test";

import { DiffEngine } from "./diff-engine";

test("DiffEngine emits only the appended suffix for continuous snapshots", () => {
  const engine = new DiffEngine();

  assert.equal(engine.diff("trace-1", "hello"), "hello");
  assert.equal(engine.diff("trace-1", "hello world"), " world");
});

test("DiffEngine falls back to the full snapshot on non-continuous resets", () => {
  const engine = new DiffEngine();

  engine.diff("trace-1", "hello world");
  assert.equal(engine.diff("trace-1", "reset"), "reset");
});

test("DiffEngine returns an empty delta when snapshots are unchanged", () => {
  const engine = new DiffEngine();

  engine.diff("trace-1", "hello");
  assert.equal(engine.diff("trace-1", "hello"), "");
});

test("DiffEngine clear resets trace state", () => {
  const engine = new DiffEngine();

  engine.diff("trace-1", "hello");
  engine.clear("trace-1");

  assert.equal(engine.diff("trace-1", "world"), "world");
});

test("DiffEngine tracks traceIds independently", () => {
  const engine = new DiffEngine();

  assert.equal(engine.diff("trace-1", "one"), "one");
  assert.equal(engine.diff("trace-2", "alpha"), "alpha");
  assert.equal(engine.diff("trace-1", "one two"), " two");
  assert.equal(engine.diff("trace-2", "alpha beta"), " beta");
});
