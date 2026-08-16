import assert from "node:assert/strict";
import { test } from "node:test";

import { getProviderCapabilities, listProviderCapabilities } from "./provider-capabilities";

test("getProviderCapabilities returns the ADS-safe codex capability map", () => {
  const capabilities = getProviderCapabilities("codex");

  assert.equal(capabilities.agent_type, "codex");
  assert.equal(capabilities.supports_ads_safe, true);
  assert.equal(capabilities.supports_read_only, true);
  assert.equal(capabilities.supports_images, false);
  assert.equal(capabilities.supports_text_files, true);
  assert.equal(capabilities.supports_pdf, false);
  assert.equal(capabilities.supports_stream_safe, true);
});

test("listProviderCapabilities returns the supported provider set in stable order", () => {
  const capabilities = listProviderCapabilities();

  assert.deepEqual(
    capabilities.map((entry) => entry.agent_type),
    ["codex", "claude", "gemini"]
  );
});
