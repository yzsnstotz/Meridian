import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runProjectPolicyCli } from "../project-policy";
import { runValidateManifestCli } from "../validate-manifest";

const FIXTURE_DIR = path.join(__dirname, "fixtures");
const VALID_MANIFEST = path.join(FIXTURE_DIR, "valid-mumu-manifest.json");
const VALID_SEEDS = path.join(FIXTURE_DIR, "valid-seeds");
const BROKEN_TRIGGER_REF = path.join(FIXTURE_DIR, "broken-trigger-ref.json");
const BROKEN_SCHEMA = path.join(FIXTURE_DIR, "broken-schema.json");
const MISSING_PROMPT = path.join(FIXTURE_DIR, "missing-prompt.json");
const BROKEN_SEED = path.join(FIXTURE_DIR, "broken-seed-manifest.json");
const BROKEN_SEEDS = path.join(FIXTURE_DIR, "broken-seeds");

describe("runValidateManifestCli", () => {
  it("validates a mumu skeleton manifest and seed files by absolute path", async () => {
    const io = createIo();

    const exitCode = await runValidateManifestCli([
      "validate-manifest",
      VALID_MANIFEST,
      VALID_SEEDS
    ], io.streams);

    expect(exitCode).toBe(0);
    expect(io.stderr()).toBe("");
    expect(io.stdout()).toContain("OK — manifest validated successfully");
    expect(io.stdout()).toContain("record_schemas=3");
    expect(io.stdout()).toContain("seed_files=1");
    expect(io.stdout()).toContain("system_prompts=3");
    expect(io.stdout()).toContain("background_triggers=1");
    expect(io.stdout()).toContain("read_only_allowlist=3");
  });

  it("returns non-zero for a background trigger record reference and cites the field path", async () => {
    const io = createIo();

    const exitCode = await runValidateManifestCli(["validate-manifest", BROKEN_TRIGGER_REF], io.streams);

    expect(exitCode).toBe(1);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("[ERROR] background_triggers");
    expect(io.stderr()).toContain("background_triggers[0].fires_on.record_type");
    expect(io.stderr()).toContain("missing_story");
  });

  it("reports malformed record schemas with their manifest field path", async () => {
    const io = createIo();

    const exitCode = await runValidateManifestCli(["validate-manifest", BROKEN_SCHEMA], io.streams);

    expect(exitCode).toBe(1);
    expect(io.stderr()).toContain("[ERROR] record_schemas");
    expect(io.stderr()).toContain("record_schemas.template_short_drama.properties.episode_count");
  });

  it("reports missing prompt files with the prompt path field", async () => {
    const io = createIo();

    const exitCode = await runValidateManifestCli(["validate-manifest", MISSING_PROMPT], io.streams);

    expect(exitCode).toBe(1);
    expect(io.stderr()).toContain("[ERROR] system_prompts");
    expect(io.stderr()).toContain("system_prompts.create_from_template.prompt_path");
  });

  it("validates seed files against matching record schemas and cites ajv paths", async () => {
    const io = createIo();

    const exitCode = await runValidateManifestCli([
      "validate-manifest",
      BROKEN_SEED,
      BROKEN_SEEDS
    ], io.streams);

    expect(exitCode).toBe(1);
    expect(io.stderr()).toContain("[ERROR] seeds");
    expect(io.stderr()).toContain("templates/template_short_drama/bad.json");
    expect(io.stderr()).toContain("/episode_count");
  });

  it("rejects read_only_allowlist entries not registered on ChatterRole", async () => {
    const io = createIo();

    const exitCode = await runValidateManifestCli([
      "validate-manifest",
      path.join(FIXTURE_DIR, "broken-read-only-skill.json")
    ], io.streams);

    expect(exitCode).toBe(1);
    expect(io.stderr()).toContain("[ERROR] read_only_allowlist");
    expect(io.stderr()).toContain("read_only_allowlist[0]");
    expect(io.stderr()).toContain("structured.missing");
  });

  it("does not mutate the manifest file", async () => {
    const before = readFileSync(VALID_MANIFEST, "utf8");

    await runValidateManifestCli(["validate-manifest", VALID_MANIFEST, VALID_SEEDS], createIo().streams);

    expect(readFileSync(VALID_MANIFEST, "utf8")).toBe(before);
  });
});

describe("project-policy CLI dispatcher", () => {
  it("routes npm-run cli validate-manifest invocations to the validator", async () => {
    const io = createIo();

    const exitCode = await runProjectPolicyCli([
      "validate-manifest",
      VALID_MANIFEST,
      VALID_SEEDS
    ], io.streams);

    expect(exitCode).toBe(0);
    expect(io.stdout()).toContain("OK — manifest validated successfully");
  });
});

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
