import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { identifyMtlsCaller, verifyMtlsCert } from "./caller-auth-mtls";
import { loadCallerRegistry } from "./caller-registry";

const tempDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("verifyMtlsCert", () => {
  it("accepts a peer certificate whose SHA-256 thumbprint matches the caller registry", async () => {
    const certBytes = Buffer.from("fake-der-cert");
    const repoRoot = await createRepoRoot();
    await writeCaller(repoRoot, {
      caller_id: "ads-mtls",
      auth_method: "mtls",
      mtls_cert_thumbprint: thumbprint(certBytes),
      allowed_project_ids: ["mumu"]
    });
    const registry = await loadCallerRegistry({ repoRoot });

    expect(verifyMtlsCert({ caller_id: "ads-mtls", peer_cert: { raw: certBytes }, registry })).toEqual({ ok: true });
  });

  it("identifies the caller by certificate thumbprint", async () => {
    const certBytes = Buffer.from("fake-der-cert");
    const repoRoot = await createRepoRoot();
    await writeCaller(repoRoot, {
      caller_id: "ads-mtls",
      auth_method: "mtls",
      mtls_cert_thumbprint: thumbprint(certBytes),
      allowed_project_ids: ["mumu"]
    });
    const registry = await loadCallerRegistry({ repoRoot });

    expect(identifyMtlsCaller({ peer_cert: { raw: certBytes }, registry })).toEqual({
      ok: true,
      caller_id: "ads-mtls"
    });
  });

  it("rejects a missing peer certificate", async () => {
    const repoRoot = await createRepoRoot();
    await writeCaller(repoRoot, {
      caller_id: "ads-mtls",
      auth_method: "mtls",
      mtls_cert_thumbprint: thumbprint(Buffer.from("fake-der-cert")),
      allowed_project_ids: ["mumu"]
    });
    const registry = await loadCallerRegistry({ repoRoot });

    expect(verifyMtlsCert({ caller_id: "ads-mtls", peer_cert: null, registry })).toEqual({
      ok: false,
      reason: "missing_peer_cert"
    });
  });
});

function thumbprint(raw: Buffer): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

async function createRepoRoot(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-callers-"));
  tempDirectories.add(directory);
  return directory;
}

async function writeCaller(repoRoot: string, caller: unknown): Promise<void> {
  const filePath = path.join(repoRoot, "config", "callers", "ads-mtls.json");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(caller, null, 2)}\n`, "utf8");
}
