import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import { completeAntigravity } from "./antigravity";

test("completeAntigravity estimates usage when agy print mode returns text without token stats", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "meridian-agy-bin-"));
  const fakeAgy = join(binDir, "agy");
  writeFileSync(
    fakeAgy,
    "#!/bin/sh\n" +
      "echo 'Antigravity response with enough words to need multiple tokens.'\n",
    "utf8"
  );
  chmodSync(fakeAgy, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;
  try {
    const result = await completeAntigravity({
      model: "antigravity/Gemini 3.1 Pro (Low)",
      messages: [{ role: "user", content: "Reply with a concise status sentence." }]
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.text, "Antigravity response with enough words to need multiple tokens.");
    assert.equal(result.model, "antigravity/Gemini 3.1 Pro (Low)");
    assert.ok(result.usage.promptTokens > 0);
    assert.ok(result.usage.completionTokens > 0);
  } finally {
    process.env.PATH = oldPath;
  }
});
