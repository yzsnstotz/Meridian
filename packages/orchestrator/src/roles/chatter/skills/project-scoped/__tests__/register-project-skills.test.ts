import { describe, expect, test, vi } from "vitest";

import type { AdsHmacTransport } from "../../../../../transport/ads-hmac";
import type { SkillManifest } from "../../../../../projects/registry";
import {
  registerProjectSkills,
  PROJECT_SKILL_DISPATCH_PREFIX
} from "../register-project-skills";
import type { Logger } from "../../../../base-role";

function dispatchKey(name: string): string {
  return `${PROJECT_SKILL_DISPATCH_PREFIX}${name}`;
}

function makeLogger(): { log: Logger; warns: unknown[][]; errors: unknown[][] } {
  const warns: unknown[][] = [];
  const errors: unknown[][] = [];
  return {
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: (...args: unknown[]) => {
        warns.push(args);
      },
      error: (...args: unknown[]) => {
        errors.push(args);
      }
    },
    warns,
    errors
  };
}

function makeTransport(): AdsHmacTransport {
  return {
    post: async () => ({
      ok: true,
      status: 200,
      json: async () => ({})
    })
  };
}

describe("registerProjectSkills", () => {
  test("skips a manifest entry that is not in the allowlist", () => {
    const skills = new Map<string, (args: unknown) => Promise<unknown>>();
    const manifest: SkillManifest = {
      fetch_dna_template: async () => "ok",
      fetch_frame: async () => "ok"
    };
    const { log } = makeLogger();

    registerProjectSkills(skills, {
      projectName: "mumu2",
      allowlist: ["fetch_dna_template"],
      manifest,
      transportFactory: () => makeTransport(),
      log
    });

    expect(skills.has(dispatchKey("fetch_dna_template"))).toBe(true);
    expect(skills.has(dispatchKey("fetch_frame"))).toBe(false);
    // raw short-name MUST NOT be registered — the chatter dispatch site
    // looks up by the prefixed key.
    expect(skills.has("fetch_dna_template")).toBe(false);
  });

  test("registered handler is invocable via the skillHandlers Map", async () => {
    const skills = new Map<string, (args: unknown) => Promise<unknown>>();
    const manifest: SkillManifest = {
      fetch_dna_template: async (_transport, input) => ({ echoed: input })
    };
    const { log } = makeLogger();

    registerProjectSkills(skills, {
      projectName: "mumu2",
      allowlist: ["fetch_dna_template"],
      manifest,
      transportFactory: () => makeTransport(),
      log
    });

    const handler = skills.get(dispatchKey("fetch_dna_template"))!;
    const result = await handler({ id: "dna-1" });
    expect(result).toEqual({ echoed: { id: "dna-1" } });
  });

  test("invoking a registered handler obtains a transport from the factory per call", async () => {
    const skills = new Map<string, (args: unknown) => Promise<unknown>>();
    const transports: AdsHmacTransport[] = [];
    const factory = vi.fn(() => {
      const transport = makeTransport();
      transports.push(transport);
      return transport;
    });
    const manifest: SkillManifest = {
      fetch_dna_template: async (transport) => {
        // record which transport instance was passed
        return transport === transports[transports.length - 1]
          ? "got-latest"
          : "got-stale";
      }
    };
    const { log } = makeLogger();

    registerProjectSkills(skills, {
      projectName: "mumu2",
      allowlist: ["fetch_dna_template"],
      manifest,
      transportFactory: factory,
      log
    });

    expect(factory).not.toHaveBeenCalled();

    const handler = skills.get(dispatchKey("fetch_dna_template"))!;
    await handler({ id: "a" });
    expect(factory).toHaveBeenCalledTimes(1);
    await handler({ id: "b" });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  test("a dispatch-key collision with an already-registered skill is skipped and logged", () => {
    const skills = new Map<string, (args: unknown) => Promise<unknown>>();
    // Simulate a prior registration at the prefixed dispatch key — e.g. a
    // second project loader running on the same chatter, or an operator
    // preseeding a custom handler under chatter.skill.fetch_dna_template.
    const preexisting = async () => "preexisting-result";
    skills.set(dispatchKey("fetch_dna_template"), preexisting);

    const manifest: SkillManifest = {
      fetch_dna_template: async () => "project-result",
      fetch_frame: async () => "ok"
    };
    const { log, warns } = makeLogger();

    registerProjectSkills(skills, {
      projectName: "mumu2",
      allowlist: ["fetch_dna_template", "fetch_frame"],
      manifest,
      transportFactory: () => makeTransport(),
      log
    });

    // First-write wins — the preexisting handler is preserved.
    expect(skills.get(dispatchKey("fetch_dna_template"))).toBe(preexisting);
    // Non-colliding allowlist entries continue to register.
    expect(skills.has(dispatchKey("fetch_frame"))).toBe(true);
    expect(warns.length).toBeGreaterThan(0);
    const matched = warns.some((entry) => {
      const meta = entry[1];
      return (
        typeof meta === "object"
        && meta !== null
        && (meta as Record<string, unknown>).skill === "fetch_dna_template"
      );
    });
    expect(matched).toBe(true);
  });

  test("empty allowlist is a no-op (no skills registered, no error)", () => {
    const skills = new Map<string, (args: unknown) => Promise<unknown>>();
    const manifest: SkillManifest = {
      fetch_dna_template: async () => "ok"
    };
    const { log, errors } = makeLogger();

    registerProjectSkills(skills, {
      projectName: "mumu2",
      allowlist: [],
      manifest,
      transportFactory: () => makeTransport(),
      log
    });

    expect(skills.size).toBe(0);
    expect(errors).toEqual([]);
  });

  test("an allowlisted name not present in the manifest logs and is skipped", () => {
    const skills = new Map<string, (args: unknown) => Promise<unknown>>();
    const manifest: SkillManifest = {
      fetch_dna_template: async () => "ok"
    };
    const { log, warns } = makeLogger();

    registerProjectSkills(skills, {
      projectName: "mumu2",
      allowlist: ["fetch_dna_template", "missing_skill"],
      manifest,
      transportFactory: () => makeTransport(),
      log
    });

    expect(skills.has(dispatchKey("fetch_dna_template"))).toBe(true);
    expect(skills.has(dispatchKey("missing_skill"))).toBe(false);
    const matched = warns.some((entry) => {
      const meta = entry[1];
      return (
        typeof meta === "object"
        && meta !== null
        && (meta as Record<string, unknown>).skill === "missing_skill"
      );
    });
    expect(matched).toBe(true);
  });
});
