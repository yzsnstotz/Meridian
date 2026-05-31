import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
const MUMU2_MANIFEST = path.join(__dirname, "../../../config/projects/mumu2/manifest.json");
const MUMU2_PROMPTS = path.join(__dirname, "../../../config/projects/mumu2/seeds/prompts");

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

  it("validates genre-named template seed directories against template record schemas", async () => {
    const seedsRoot = mkdtempSync(path.join(tmpdir(), "validate-genre-seeds-"));
    const seedDir = path.join(seedsRoot, "templates", "short_drama");
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(path.join(seedDir, "rebirth.json"), JSON.stringify({
      id: "rebirth",
      title: "Rebirth Contract",
      episode_count: 12
    }));
    const io = createIo();

    const exitCode = await runValidateManifestCli([
      "validate-manifest",
      VALID_MANIFEST,
      seedsRoot
    ], io.streams);

    expect(exitCode).toBe(0);
    expect(io.stderr()).toBe("");
    expect(io.stdout()).toContain("seed_files=1");
  });

  it("resolves explicit relative seeds paths from the current working directory", async () => {
    const cwdRelativeSeeds = path.relative(process.cwd(), VALID_SEEDS);
    const io = createIo();

    const exitCode = await runValidateManifestCli([
      "validate-manifest",
      VALID_MANIFEST,
      cwdRelativeSeeds
    ], io.streams);

    expect(exitCode).toBe(0);
    expect(io.stderr()).toBe("");
    expect(io.stdout()).toContain("seed_files=1");
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

  it("returns non-zero for a background trigger prompt reference and passes after the reference is fixed", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "validate-trigger-prompt-"));
    mkdirSync(path.join(root, "prompts"));
    writeFileSync(path.join(root, "prompts", "style_observe.md"), "observe style");
    const manifestPath = path.join(root, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(makeTriggerPromptManifest("missing_prompt")));
    const brokenIo = createIo();

    const brokenExitCode = await runValidateManifestCli(["validate-manifest", manifestPath], brokenIo.streams);

    expect(brokenExitCode).toBe(1);
    expect(brokenIo.stdout()).toBe("");
    expect(brokenIo.stderr()).toContain("[ERROR] background_triggers");
    expect(brokenIo.stderr()).toContain("background_triggers[0].action.system_prompt_id");
    expect(brokenIo.stderr()).toContain("missing_prompt");

    writeFileSync(manifestPath, JSON.stringify(makeTriggerPromptManifest("style_observe")));
    const fixedIo = createIo();

    const fixedExitCode = await runValidateManifestCli(["validate-manifest", manifestPath], fixedIo.streams);

    expect(fixedExitCode).toBe(0);
    expect(fixedIo.stderr()).toBe("");
    expect(fixedIo.stdout()).toContain("background_triggers=1");
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

  it("registers mumu2 world rules prompts with the expected op contract", async () => {
    const io = createIo();

    const exitCode = await runValidateManifestCli(["validate-manifest", MUMU2_MANIFEST], io.streams);

    expect(exitCode).toBe(0);
    expect(io.stderr()).toBe("");
    expect(io.stdout()).toContain("system_prompts=9");

    const manifest = JSON.parse(readFileSync(MUMU2_MANIFEST, "utf8")) as {
      system_prompts: Record<string, { prompt_path: string }>;
    };
    expect(manifest.system_prompts.mumu2_chat_world_rules).toEqual({
      prompt_path: "seeds/prompts/mumu2_chat_world_rules.md"
    });
    expect(manifest.system_prompts.mumu2_promote_world_rules).toEqual({
      prompt_path: "seeds/prompts/mumu2_promote_world_rules.md"
    });

    const chatPrompt = readFileSync(path.join(MUMU2_PROMPTS, "mumu2_chat_world_rules.md"), "utf8");
    expect(chatPrompt).toContain('"active_slot"');
    expect(chatPrompt).toContain('"world_rules"');
    expect(chatPrompt).toContain('"add_world_rule"');
    expect(chatPrompt).toContain('"update_world_rule"');
    expect(chatPrompt).toContain('"delete_world_rule"');
    expect(chatPrompt).toContain("patch");
    expect(chatPrompt).toContain("不得包含 `id`");
    expect(chatPrompt).toContain("何时主动调用 fetch_X 工具");
    expect(chatPrompt).toContain("笔记本观察提案");

    const promotePrompt = readFileSync(path.join(MUMU2_PROMPTS, "mumu2_promote_world_rules.md"), "utf8");
    expect(promotePrompt).toContain('"active_slot"');
    expect(promotePrompt).toContain('"world_rules"');
    expect(promotePrompt).toContain('"add_world_rule"');
    expect(promotePrompt).not.toContain('"update_world_rule"');
    expect(promotePrompt).not.toContain('"delete_world_rule"');
    expect(promotePrompt).toContain("何时主动调用 fetch_X 工具");
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

function makeTriggerPromptManifest(systemPromptId: string): unknown {
  return {
    version: 1,
    layers: "flat",
    index: "none",
    bindings: {},
    record_schemas: {
      test_story: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false
      }
    },
    system_prompts: {
      style_observe: { prompt_path: "prompts/style_observe.md" }
    },
    background_triggers: [{
      name: "style_observe_after_stories",
      fires_on: {
        type: "after_structured_upsert",
        record_type: "test_story"
      },
      throttle: {
        min_records_since_last_fire: 3,
        min_interval: "1s"
      },
      action: { system_prompt_id: systemPromptId }
    }]
  };
}
