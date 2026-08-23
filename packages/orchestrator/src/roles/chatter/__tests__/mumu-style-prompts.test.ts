import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const mumuRoot = path.join(repoRoot, "config", "projects", "mumu");

function readProjectFile(relativePath: string): string {
  return readFileSync(path.join(mumuRoot, relativePath), "utf8");
}

describe("mumu StyleProfile prompt contracts", () => {
  it("declares the preview-only AI style fill prompt in the manifest", () => {
    const manifest = JSON.parse(readProjectFile("manifest.json")) as {
      system_prompts?: Record<string, { prompt_path?: string }>;
    };

    expect(manifest.system_prompts?.style_refine_user_write).toEqual({
      prompt_path: "seeds/prompts/style_refine_user_write.md"
    });
  });

  it("allows explicit style saves for every Phase 2 genre without cross-writing", () => {
    const prompt = readProjectFile("seeds/prompts/style_user_write.md");

    for (const recordType of [
      "style_short_drama",
      "style_lianxian",
      "style_douyin",
      "style_variety"
    ]) {
      expect(prompt).toContain(recordType);
    }

    expect(prompt).toContain("user_authored");
    expect(prompt).toContain("agent_observed");
    expect(prompt).toContain("不要跨 genre 写入");
  });

  it("keeps AI style fill advisory and forbids direct persistence tools", () => {
    const prompt = readProjectFile("seeds/prompts/style_refine_user_write.md");

    expect(prompt).toContain("strict JSON");
    expect(prompt).toContain("proposed");
    expect(prompt).toContain("rationale");
    expect(prompt).toContain("preview");
    expect(prompt).toContain("must not call");
    expect(prompt).toContain("structured.upsert");
    expect(prompt).toContain("structured.delete");
    expect(prompt).toContain("chatter.suggest_observation");
  });
});
