import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeModel } from "./shared";

test("normalizeModel preserves Antigravity provider prefix inside outer gateway namespaces", () => {
  assert.equal(
    normalizeModel("custom-meridian-gateway/antigravity/gemini-3-pro"),
    "antigravity/gemini-3-pro"
  );
  assert.equal(normalizeModel("antigravity/gemini-2.5-flash"), "antigravity/gemini-2.5-flash");
  assert.equal(normalizeModel("custom-meridian-gateway/gpt-5.4"), "gpt-5.4");
});
