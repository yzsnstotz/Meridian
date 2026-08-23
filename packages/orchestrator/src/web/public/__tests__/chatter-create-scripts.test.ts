import * as fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The chatter create form must source its `llm_agent_kind`, `llm_model`,
 * and `credential_id` options from meridian-roles endpoints (which in turn
 * follow whatever meridian-hub publishes). The HTML carries no hard-coded
 * single-option list so chatter never drifts out of sync with hub support.
 */
describe("chatter-create.html", () => {
  const publicDir = path.resolve(process.cwd(), "src/web/public");

  it("uses dropdowns wired to /api/agent-kinds and /api/credentials", async () => {
    const html = await fs.readFile(path.join(publicDir, "chatter-create.html"), "utf8");

    // The kind and model dropdowns exist with stable ids the script reads.
    expect(html).toContain('id="chatter-llm-agent-kind"');
    expect(html).toContain('id="chatter-llm-model"');

    // Credential picker reuses the existing data-credential-select pattern
    // (consistent with the dispatcher form) and starts with the default option.
    expect(html).toContain('id="chatter-credential-id"');
    expect(html).toContain('data-credential-select');
    expect(html).toMatch(/Use default codex login/);

    // The inline script must call both endpoints so chatter has no
    // hard-coded enum baked into the page.
    expect(html).toMatch(/\/api\/agent-kinds/);
    expect(html).toMatch(/\/api\/credentials/);

    // Revoked credentials are filtered before rendering options.
    expect(html).toMatch(/revoked_at/);

    // Single-option "claude-code" placeholder must no longer be hard-coded.
    expect(html).not.toMatch(/<option value="claude-code">claude-code<\/option>/);
  });

  it("submit body forwards llm_model only when an operator picked one", async () => {
    const html = await fs.readFile(path.join(publicDir, "chatter-create.html"), "utf8");

    // The serializer must short-circuit on empty model — otherwise blank
    // strings would reach the hub side and fail schema validation.
    expect(html).toMatch(/llmModel\.length > 0/);
    expect(html).toMatch(/config\.llm_model = llmModel/);
  });
});
