import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const mumuRoot = path.join(repoRoot, "config", "projects", "mumu");

type Artifact = {
  key: string;
  source: "fragment" | "outline";
  label: string;
};

type CreativeSpine = Record<
  string,
  {
    canonical_artifacts: Artifact[];
    planning_artifacts: Artifact[];
    derived_artifacts: Artifact[];
    support_artifacts: Artifact[];
  }
>;

function readProjectFile(relativePath: string): string {
  return readFileSync(path.join(mumuRoot, relativePath), "utf8");
}

function expectReplyBlockContract(prompt: string): void {
  expect(prompt).toContain("<<<MUMU-USER-REPLY>>>");
  expect(prompt).toContain("<<<END-MUMU-USER-REPLY>>>");
  expect(prompt).toMatch(/只(?:能)?(?:输出|包含|出现)一个|必须且只能|且只输出一个/u);
}

function expectNoReplyLeakInstructions(prompt: string): void {
  for (const line of prompt.split(/\r?\n/u)) {
    if (!/(回复|对话)/u.test(line)) {
      continue;
    }
    expect(line).not.toMatch(/(structured\/|\.json|record_type|template_id|JSON 校验|已写入|落库|文件路径|路径|工具|实现步骤)/iu);
  }
}

function fragmentTypes(entry: CreativeSpine[string]): string[] {
  return [
    ...entry.canonical_artifacts,
    ...entry.planning_artifacts,
    ...entry.derived_artifacts,
    ...entry.support_artifacts
  ]
    .filter((artifact) => artifact.source === "fragment")
    .map((artifact) => artifact.key);
}

describe("mumu creative-spine registry", () => {
  it("declares canonical artifacts for every supported genre", () => {
    const registry = JSON.parse(readProjectFile("creative-spine.json")) as CreativeSpine;

    for (const genre of ["short_drama", "lianxian", "douyin", "variety"]) {
      expect(registry[genre]?.canonical_artifacts.length).toBeGreaterThan(0);
    }

    expect(registry.douyin?.canonical_artifacts.map((artifact) => artifact.key)).toEqual(["full_script"]);
    expect(registry.douyin?.derived_artifacts.some((artifact) => artifact.key === "visual_beats")).toBe(true);
    expect(fragmentTypes(registry.douyin!)).not.toContain("dialogue");
  });

  it("keeps manifest fragment enums aligned with the registry", () => {
    const registry = JSON.parse(readProjectFile("creative-spine.json")) as CreativeSpine;
    const manifest = JSON.parse(readProjectFile("manifest.json")) as {
      record_schemas?: Record<string, { properties?: { fragments?: { items?: { properties?: { type?: { enum?: string[] } } } } } }>;
    };

    for (const [genre, entry] of Object.entries(registry)) {
      const enumValues =
        manifest.record_schemas?.[`story_${genre}`]?.properties?.fragments?.items?.properties?.type?.enum ?? [];
      expect(enumValues).toEqual(fragmentTypes(entry));
    }
  });

  it("teaches create_from_template to use registry labels instead of competing scripts", () => {
    const registry = JSON.parse(readProjectFile("creative-spine.json")) as CreativeSpine;
    const prompt = readProjectFile("seeds/prompts/create_from_template.md");

    for (const [genre, entry] of Object.entries(registry)) {
      expect(prompt).toContain(genre);
      for (const artifact of entry.canonical_artifacts) {
        expect(prompt).toContain(artifact.key);
        expect(prompt).toContain(artifact.label);
      }
    }

    expect(prompt).toContain("full_script -> visual_beats");
    expect(prompt).toContain("不要为单个镜头创建独立口播稿");
  });

  it("requires the user-reply block contract in every mumu generation prompt", () => {
    for (const promptPath of ["seeds/prompts/create_from_template.md", "seeds/prompts/optimize_from_template.md"]) {
      expectReplyBlockContract(readProjectFile(promptPath));
    }
  });

  it("keeps user reply instructions free of implementation narration", () => {
    for (const promptPath of ["seeds/prompts/create_from_template.md", "seeds/prompts/optimize_from_template.md"]) {
      expectNoReplyLeakInstructions(readProjectFile(promptPath));
    }
  });

  it("spells out douyin and variety create behavior", () => {
    const prompt = readProjectFile("seeds/prompts/create_from_template.md");

    expect(prompt).toContain("生成完整抖音短视频");
    expect(prompt).toContain("先生成或更新整条视频的 full_script");
    expect(prompt).toContain("再从 full_script 派生 visual_beats[]");
    expect(prompt).toContain("单个镜头");
    expect(prompt).toContain("对应切片");
    expect(prompt).toContain("已同步照读口播和拍摄分镜");

    expect(prompt).toContain("story_variety");
    expect(prompt).toContain("run_of_show");
    expect(prompt).toContain("host_script");
    expect(prompt).toContain("主持照读稿");
    expect(prompt).toContain("辅助资料");
  });
});
