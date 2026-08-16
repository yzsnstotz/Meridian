import { afterEach, describe, expect, it } from "vitest";

import { getCallerIdentity, resetCallerIdentityCache } from "./caller-identity";

const originalEnv = { ...process.env };

afterEach(() => {
  resetCallerIdentityCache();

  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
});

describe("getCallerIdentity", () => {
  it("uses the Meridian-Roles display label by default", () => {
    process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY = "test-bootstrap-seed";
    delete process.env.MERIDIAN_ROLES_CALLER_LABEL;

    expect(getCallerIdentity().caller_label).toBe("Meridian-Roles");
  });
});
