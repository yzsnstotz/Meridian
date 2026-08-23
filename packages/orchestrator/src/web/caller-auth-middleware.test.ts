import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ForbiddenProjectError,
  assertCallerMayAccessProject,
  createRequireCallerAuth,
  type CallerAuthenticatedRequest
} from "./caller-auth-middleware";
import { loadCallerRegistry } from "./caller-registry";

const tempDirectories = new Set<string>();

afterEach(async () => {
  delete process.env.ADS_HMAC_KEY;
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("createRequireCallerAuth", () => {
  it("passes a valid HMAC-signed request and attaches the verified caller", async () => {
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
    const request = makeRequest(body, { "x-meridian-caller-signature": `sha256=${sign(body, "super-secret")}` });
    const response = makeResponse();
    let nextCalled = false;

    await createRequireCallerAuth({ registry })(request, response, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(response.statusCode).toBeUndefined();
    expect(request.caller).toEqual({ caller_id: "ads" });
    expect(request.body_bytes).toEqual(body);
  });

  it("returns 401 without trusting a forged caller_id header", async () => {
    process.env.ADS_HMAC_KEY = "super-secret";
    const repoRoot = await createRepoRoot();
    await writeCaller(repoRoot, {
      caller_id: "ads",
      auth_method: "hmac",
      hmac_key_env: "ADS_HMAC_KEY",
      allowed_project_ids: ["mumu"]
    });
    const registry = await loadCallerRegistry({ repoRoot });
    const request = makeRequest(Buffer.from("{}"), {
      "x-meridian-caller-id": "ads",
      "x-meridian-caller-signature": "sha256=deadbeef"
    });
    const response = makeResponse();

    await createRequireCallerAuth({ registry })(request, response, () => {
      throw new Error("next should not run");
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: "denied_caller_auth", reason: "invalid_signature" });
    expect(response.body).not.toContain("super-secret");
  });

  it("fails loudly when a registered HMAC caller references an unset env var", async () => {
    const repoRoot = await createRepoRoot();
    await writeCaller(repoRoot, {
      caller_id: "ads",
      auth_method: "hmac",
      hmac_key_env: "ADS_HMAC_KEY",
      allowed_project_ids: ["mumu"]
    });

    await expect(loadCallerRegistry({ repoRoot })).rejects.toThrow("ADS_HMAC_KEY");
  });
});

describe("assertCallerMayAccessProject", () => {
  it("allows registered project access", async () => {
    process.env.ADS_HMAC_KEY = "super-secret";
    const repoRoot = await createRepoRoot();
    await writeCaller(repoRoot, {
      caller_id: "ads",
      auth_method: "hmac",
      hmac_key_env: "ADS_HMAC_KEY",
      allowed_project_ids: ["mumu"]
    });
    const registry = await loadCallerRegistry({ repoRoot });

    expect(() => assertCallerMayAccessProject("ads", "mumu", registry)).not.toThrow();
  });

  it("supports downstream two-argument checks after middleware registry initialization", async () => {
    process.env.ADS_HMAC_KEY = "super-secret";
    const repoRoot = await createRepoRoot();
    await writeCaller(repoRoot, {
      caller_id: "ads",
      auth_method: "hmac",
      hmac_key_env: "ADS_HMAC_KEY",
      allowed_project_ids: ["mumu"]
    });
    const registry = await loadCallerRegistry({ repoRoot });
    createRequireCallerAuth({ registry });

    expect(() => assertCallerMayAccessProject("ads", "mumu")).not.toThrow();
    expect(() => assertCallerMayAccessProject("ads", "other")).toThrow(ForbiddenProjectError);
  });

  it("throws ForbiddenProjectError outside the caller allowlist", async () => {
    process.env.ADS_HMAC_KEY = "super-secret";
    const repoRoot = await createRepoRoot();
    await writeCaller(repoRoot, {
      caller_id: "ads",
      auth_method: "hmac",
      hmac_key_env: "ADS_HMAC_KEY",
      allowed_project_ids: ["mumu"]
    });
    const registry = await loadCallerRegistry({ repoRoot });

    expect(() => assertCallerMayAccessProject("ads", "other", registry)).toThrow(ForbiddenProjectError);
  });
});

function sign(body: Buffer, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function makeRequest(body: Buffer, headers: Record<string, string>): CallerAuthenticatedRequest {
  const request = Readable.from([body]) as CallerAuthenticatedRequest;
  request.headers = headers;
  return request;
}

function makeResponse(): { statusCode?: number; headers: Record<string, string>; body: string; setHeader(name: string, value: string): void; end(chunk: string): void } {
  return {
    headers: {},
    body: "",
    setHeader(name: string, value: string): void {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk: string): void {
      this.body += chunk;
    }
  };
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
