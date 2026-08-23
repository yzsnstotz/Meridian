import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectNotRegisteredError,
  interpolatePolicyForUser,
  loadProjectPolicy
} from "./project-policy-loader";
import type { ProjectPolicy } from "./project-policy-schema";
import { runProjectPolicyCli } from "../cli/project-policy";

const tempDirectories = new Set<string>();

const validPolicy = {
  project_id: "mumu",
  thread_id_pattern: "chatter-mumu-user-{user_id}",
  memory_folder_pattern: "/data/mumu/users/{user_id}",
  manifest_path: "/etc/meridian-roles/projects/mumu/manifest.json",
  seeds_source_path: "/etc/meridian-roles/projects/mumu/seeds",
  allowed_modes: ["session", "stateless"],
  skill_allowlist: ["structured.upsert", "structured.get"],
  llm_agent_kind: "claude-code",
  credential_id: null,
  user_reply_channel_template: {
    channel: "socket",
    chat_id: "ads:mumu:{user_id}",
    socket_path: "/var/run/ads-mumu.sock"
  },
  seeds_init: { mode: "copy_on_provision" }
} satisfies ProjectPolicy;

afterEach(async () => {
  await Promise.all(Array.from(tempDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("loadProjectPolicy", () => {
  it("loads and validates a project policy from config/projects", async () => {
    const repoRoot = await createRepoRoot();
    await writePolicy(repoRoot, "mumu", validPolicy);

    const policy = await loadProjectPolicy("mumu", { repoRoot });

    expect(policy).toEqual(validPolicy);
  });

  it("throws ProjectNotRegisteredError when the project file is missing", async () => {
    const repoRoot = await createRepoRoot();

    await expect(loadProjectPolicy("missing", { repoRoot })).rejects.toBeInstanceOf(ProjectNotRegisteredError);
  });

  it("throws InvalidProjectPolicyError with the failing field when schema validation fails", async () => {
    const repoRoot = await createRepoRoot();
    await writePolicy(repoRoot, "mumu", {
      ...validPolicy,
      manifest_path: ""
    });

    await expect(loadProjectPolicy("mumu", { repoRoot })).rejects.toMatchObject({
      name: "InvalidProjectPolicyError",
      fieldPaths: ["manifest_path"]
    });
  });

  it("does not mutate the parsed policy before returning it", async () => {
    const repoRoot = await createRepoRoot();
    await writePolicy(repoRoot, "mumu", validPolicy);

    const policy = await loadProjectPolicy("mumu", { repoRoot });

    expect(policy).toEqual(validPolicy);
    expect(policy).not.toHaveProperty("thread_id");
    expect(policy).not.toHaveProperty("memory_folder");
  });
});

describe("interpolatePolicyForUser", () => {
  it("substitutes user_id placeholders in derived user policy fields", () => {
    const interpolated = interpolatePolicyForUser(validPolicy, "u_001");

    expect(interpolated.thread_id).toBe("chatter-mumu-user-u_001");
    expect(interpolated.memory_folder).toBe("/data/mumu/users/u_001");
    expect(interpolated.user_reply_channel.chat_id).toBe("ads:mumu:u_001");
    expect(interpolated.project_id).toBe("mumu");
  });

  it("refuses unknown placeholders in policy patterns", () => {
    expect(() =>
      interpolatePolicyForUser(
        {
          ...validPolicy,
          memory_folder_pattern: "/data/{tenant_id}/{user_id}"
        },
        "u_001"
      )
    ).toThrow("Unknown placeholder");
  });

  it("uses the project policy llm_agent_kind when no env override is set", () => {
    delete process.env.MUMU_LLM_AGENT_KIND;
    const interpolated = interpolatePolicyForUser(validPolicy, "u_001");
    expect(interpolated.llm_agent_kind).toBe(validPolicy.llm_agent_kind);
  });

  it("respects per-project <PROJECT_ID>_LLM_AGENT_KIND env override at interpolation time", () => {
    process.env.MUMU_LLM_AGENT_KIND = "codex";
    try {
      const interpolated = interpolatePolicyForUser(validPolicy, "u_001");
      expect(interpolated.llm_agent_kind).toBe("codex");
    } finally {
      delete process.env.MUMU_LLM_AGENT_KIND;
    }
  });

  it("ignores empty/whitespace env override", () => {
    process.env.MUMU_LLM_AGENT_KIND = "   ";
    try {
      const interpolated = interpolatePolicyForUser(validPolicy, "u_001");
      expect(interpolated.llm_agent_kind).toBe(validPolicy.llm_agent_kind);
    } finally {
      delete process.env.MUMU_LLM_AGENT_KIND;
    }
  });
});

describe("runProjectPolicyCli", () => {
  it("returns zero for a valid policy", async () => {
    const repoRoot = await createRepoRoot();
    await writePolicy(repoRoot, "mumu", validPolicy);
    const io = createIo();

    const exitCode = await runProjectPolicyCli(["validate", "mumu", "--repo-root", repoRoot], io.streams);

    expect(exitCode).toBe(0);
    expect(io.stdout()).toContain("valid");
    expect(io.stderr()).toBe("");
  });

  it("returns non-zero with a line-numbered field error for an invalid policy", async () => {
    const repoRoot = await createRepoRoot();
    const policyPath = path.join(repoRoot, "config", "projects", "mumu.json");
    await fs.mkdir(path.dirname(policyPath), { recursive: true });
    await fs.writeFile(
      policyPath,
      JSON.stringify(
        {
          ...validPolicy,
          manifest_path: ""
        },
        null,
        2
      ),
      "utf8"
    );
    const io = createIo();

    const exitCode = await runProjectPolicyCli(["validate", "mumu", "--repo-root", repoRoot], io.streams);

    expect(exitCode).toBe(1);
    expect(io.stderr()).toMatch(/line \d+/);
    expect(io.stderr()).toContain("manifest_path");
  });
});

async function createRepoRoot(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-policy-"));
  tempDirectories.add(directory);
  return directory;
}

async function writePolicy(repoRoot: string, projectId: string, policy: unknown): Promise<void> {
  const policyPath = path.join(repoRoot, "config", "projects", `${projectId}.json`);
  await fs.mkdir(path.dirname(policyPath), { recursive: true });
  await fs.writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
}

function createIo(): {
  streams: {
    stdout: { write(chunk: string): unknown };
    stderr: { write(chunk: string): unknown };
  };
  stdout(): string;
  stderr(): string;
} {
  let stdout = "";
  let stderr = "";

  return {
    streams: {
      stdout: {
        write(chunk: string): boolean {
          stdout += chunk;
          return true;
        }
      },
      stderr: {
        write(chunk: string): boolean {
          stderr += chunk;
          return true;
        }
      }
    },
    stdout(): string {
      return stdout;
    },
    stderr(): string {
      return stderr;
    }
  };
}
