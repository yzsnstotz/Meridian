import * as fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Role-config GUI must offer a credential selector for the dispatcher and
 * each codex sub-spawn (validator + pm_resolver). The dropdown is wired
 * to GET /api/credentials at load time; the form serializer in app.js
 * forwards `credential_id` (or nested validator/pm_resolver.credential_id)
 * only when an operator picks a non-default option.
 */
describe("role-config credential selectors", () => {
  const publicDir = path.resolve(process.cwd(), "src/web/public");

  it("index.html (creation form) includes credential selectors for dispatcher, validator, pm_resolver", async () => {
    const indexHtml = await fs.readFile(path.join(publicDir, "index.html"), "utf8");

    // Main dispatcher credential picker
    expect(indexHtml).toContain('id="agent-dispatcher-credential-id"');
    expect(indexHtml).toContain('name="credential_id"');

    // Validator override
    expect(indexHtml).toContain('id="agent-dispatcher-validator-credential-id"');
    expect(indexHtml).toContain('name="validator_credential_id"');

    // PM resolver override
    expect(indexHtml).toContain('id="agent-dispatcher-pm-credential-id"');
    expect(indexHtml).toContain('name="pm_credential_id"');

    // Default option text is exposed so operators understand what blank means
    expect(indexHtml).toMatch(/Use default codex login/);

    // Visible label per BS requirement: "Credential"
    expect(indexHtml).toMatch(/Credential/);
  });

  it("config.html (edit form) includes credential selectors for dispatcher, validator, pm_resolver", async () => {
    const configHtml = await fs.readFile(path.join(publicDir, "config.html"), "utf8");

    expect(configHtml).toContain('id="cfg-credential-id"');
    expect(configHtml).toContain('id="cfg-validator-credential-id"');
    expect(configHtml).toContain('id="cfg-pm-credential-id"');

    // Default option text is exposed so operators understand what blank means
    expect(configHtml).toMatch(/Use default codex login/);
    expect(configHtml).toMatch(/Credential/);
  });

  it("app.js fetches /api/credentials, filters revoked entries, and forwards credential_id on submit", async () => {
    const appScript = await fs.readFile(path.join(publicDir, "app.js"), "utf8");

    // Hits the new endpoint
    expect(appScript).toMatch(/\/api\/credentials/);

    // Filters revoked credentials when rendering the dropdown
    expect(appScript).toMatch(/revoked_at/);

    // Form submit forwards credential_id at the top level
    expect(appScript).toMatch(/credential_id/);

    // Validator override is wired into collectValidatorConfig
    expect(appScript).toMatch(/agent-dispatcher-credential-id/);
    expect(appScript).toMatch(/agent-dispatcher-validator-credential-id/);
    // PM credential is collected via the prefixed collectPmResolverConfig helper,
    // so the literal id is built as `${prefix}-credential-id`.
    expect(appScript).toMatch(/\$\{prefix\}-credential-id/);

    // Config edit page also reads the credential fields directly
    expect(appScript).toMatch(/cfg-credential-id/);
    expect(appScript).toMatch(/cfg-validator-credential-id/);
    expect(appScript).toMatch(/cfg-pm-credential-id/);
  });
});
