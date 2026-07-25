import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkPackageBoundaries } from "./check-package-boundaries.mjs";

async function workspaceWith(importLine) {
  const root = await mkdtemp(join(tmpdir(), "meridian-boundaries-"));
  await mkdir(join(root, "packages", "gateway", "src"), { recursive: true });
  await writeFile(
    join(root, "packages", "gateway", "package.json"),
    JSON.stringify({ name: "@meridian/gateway" }),
  );
  await writeFile(join(root, "packages", "gateway", "src", "index.ts"), importLine);
  return root;
}

test("accepts an allowed contracts dependency", async () => {
  const root = await workspaceWith('import type { Service } from "@meridian/contracts";\n');
  assert.deepEqual(await checkPackageBoundaries(root), []);
});

test("rejects gateway coupling to orchestrator", async () => {
  const root = await workspaceWith('import { dispatch } from "@meridian/orchestrator";\n');
  const violations = await checkPackageBoundaries(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /gateway.*orchestrator/);
});

test("rejects a relative import that escapes its package", async () => {
  const root = await workspaceWith('import { dispatch } from "../../orchestrator/src/index";\n');
  const violations = await checkPackageBoundaries(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /escapes package boundary/);
});
