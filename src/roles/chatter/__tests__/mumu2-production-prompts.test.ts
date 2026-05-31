import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

type Mumu2Manifest = {
  system_prompts?: Record<string, { prompt_path: string }>;
};

const REQUIRED_PROMPTS = [
  "mumu2_chat_production",
  "mumu2_promote_cast_assets",
  "mumu2_promote_location_assets",
  "mumu2_promote_prop_assets",
  "mumu2_promote_sfx_assets",
  "mumu2_promote_shot_assets",
  "mumu2_promote_continuity_anchors"
] as const;

const PROMPT_EXPECTATIONS: Record<typeof REQUIRED_PROMPTS[number], string[]> = {
  mumu2_chat_production: [
    "bundle.production",
    "add_asset",
    "update_asset",
    "delete_asset",
    "ProductionOp"
  ],
  mumu2_promote_cast_assets: ["bundle.cast", "bundle.script", "add_asset", "\"kind\":\"cast\""],
  mumu2_promote_location_assets: ["bundle.scenes", "bundle.script", "add_asset", "\"kind\":\"location\""],
  mumu2_promote_prop_assets: ["bundle.scenes", "bundle.script", "add_asset", "\"kind\":\"prop\""],
  mumu2_promote_sfx_assets: ["bundle.scenes", "bundle.script", "add_asset", "\"kind\":\"sfx\""],
  mumu2_promote_shot_assets: ["bundle.scenes", "bundle.script", "add_asset", "\"kind\":\"shot\""],
  mumu2_promote_continuity_anchors: [
    "bundle.cast",
    "bundle.scenes",
    "bundle.script",
    "bundle.production",
    "add_asset",
    "\"kind\":\"continuity_anchor\""
  ]
};

describe("mumu2 production prompts", () => {
  it("registers the full production prompt set and documents schema-compatible ProductionOps", () => {
    const projectRoot = path.join(process.cwd(), "config/projects/mumu2");
    const manifest = JSON.parse(
      readFileSync(path.join(projectRoot, "manifest.json"), "utf8")
    ) as Mumu2Manifest;

    for (const promptId of REQUIRED_PROMPTS) {
      const prompt = manifest.system_prompts?.[promptId];
      expect(prompt, `${promptId} must be registered in manifest.json`).toBeDefined();

      const promptText = readFileSync(path.join(projectRoot, prompt!.prompt_path), "utf8");
      expect(promptText).toContain("[OPS_JSON]");

      for (const expected of PROMPT_EXPECTATIONS[promptId]) {
        expect(promptText, `${promptId} should mention ${expected}`).toContain(expected);
      }
    }
  });
});
