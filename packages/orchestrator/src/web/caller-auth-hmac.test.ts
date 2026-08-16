import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { identifyHmacCaller, verifyHmacSignature } from "./caller-auth-hmac";
import { loadCallerRegistry } from "./caller-registry";

const tempDirectories = new Set<string>();

afterEach(async () => {
  delete process.env.ADS_HMAC_KEY;
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("verifyHmacSignature", () => {
  it("accepts a valid HMAC signature for the registered caller", async () => {
    process.env.ADS_HMAC_KEY = "super-secret";
    const repoRoot = await createRepoRoot();
    await writeCaller(repoRoot, {
      caller_id: "ads",
      auth_method: "hmac",
      hmac_key_env: "ADS_HMAC_KEY",
      allowed_project_ids: ["mumu"]
    });
    const registry = await loadCallerRegistry({ repoRoot });
    const body = Buffer.from(JSON.stringify({ project_id: "mumu" }));
    const signature = sign(body, process.env.ADS_HMAC_KEY);

    expect(verifyHmacSignature({ caller_id: "ads", body_bytes: body, signature_header: `sha256=${signature}`, registry })).toEqual({
      ok: true
    });
  });

  it("rejects an invalid signature without echoing secret material", async () => {
    process.env.ADS_HMAC_KEY = "super-secret";
    const repoRoot = await createRepoRoot();
    await writeCaller(repoRoot, {
      caller_id: "ads",
      auth_method: "hmac",
      hmac_key_env: "ADS_HMAC_KEY",
      allowed_project_ids: ["mumu"]
    });
    const registry = await loadCallerRegistry({ repoRoot });

    const result = verifyHmacSignature({
      caller_id: "ads",
      body_bytes: Buffer.from("{}"),
      signature_header: "sha256=deadbeef",
      registry
    });

    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it("identifies the caller by a matching signature instead of trusting a caller_id header", async () => {
    process.env.ADS_HMAC_KEY = "super-secret";
    const repoRoot = await createRepoRoot();
    await writeCaller(repoRoot, {
      caller_id: "ads",
      auth_method: "hmac",
      hmac_key_env: "ADS_HMAC_KEY",
      allowed_project_ids: ["mumu"]
    });
    const registry = await loadCallerRegistry({ repoRoot });
    const body = Buffer.from("{}");

    expect(identifyHmacCaller({ body_bytes: body, signature_header: `sha256=${sign(body, "super-secret")}`, registry })).toEqual({
      ok: true,
      caller_id: "ads"
    });
  });
});

function sign(body: Buffer, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

async function createRepoRoot(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-callers-"));
  tempDirectories.add(directory);
  return directory;
}

async function writeCaller(repoRoot: string, caller: unknown): Promise<void> {
  const filePath = path.join(repoRoot, "config", "callers", "ads.json");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(caller, null, 2)}\n`, "utf8");
}
