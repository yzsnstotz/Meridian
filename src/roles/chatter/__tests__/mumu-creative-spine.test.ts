import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadManifestFromFile, validateRecord } from "../manifest";

const repoRoot = process.cwd();
const mumuRoot = path.join(repoRoot, "config", "projects", "mumu");

type Artifact = {
  key: string;
  source: "fragment" | "outline";
  label: string;
  description?: string;
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

  it("covers every manifest story category in the create prompt", () => {
    const registry = JSON.parse(readProjectFile("creative-spine.json")) as CreativeSpine;
    const manifest = JSON.parse(readProjectFile("manifest.json")) as {
      record_schemas?: Record<string, unknown>;
    };
    const prompt = readProjectFile("seeds/prompts/create_from_template.md");
    const storyGenres = Object.keys(manifest.record_schemas ?? {})
      .filter((schemaName) => schemaName.startsWith("story_"))
      .map((schemaName) => schemaName.slice("story_".length))
      .sort();

    expect(storyGenres).toEqual(Object.keys(registry).sort());
    for (const genre of storyGenres) {
      expect(prompt).toContain(`### ${genre}: story_${genre}`);
      expect(prompt).toContain(`structured/story_${genre}/<uuid>.json`);
    }
  });

  it("requires the user-reply block contract in every mumu generation prompt", () => {
    for (const promptPath of ["seeds/prompts/create_from_template.md", "seeds/prompts/optimize_from_template.md"]) {
      expectReplyBlockContract(readProjectFile(promptPath));
    }
  });

  it("defines multi-source extraction and schema-valid candidate requirements", () => {
    const prompt = readProjectFile("seeds/prompts/extract_template_from_draft.md");

    expect(prompt).toContain("多源抽取");
    expect(prompt).toContain("共同结构");
    expect(prompt).toContain("差异特征");
    expect(prompt).toContain("same-category");
    expect(prompt).toContain("category evidence");
    expect(prompt).toContain("template_<genre>");
    expect(prompt).toContain("schema-valid");
    expect(prompt).toContain("template_lianxian");
    expect(prompt).toContain("overall_arc");
    expect(prompt).toContain("segment_pattern");
    expect(prompt).toContain("chatter.suggest_observation");
    expect(prompt).not.toContain("structured.upsert 写入");
  });

  it("tells create turns that selected references are context-only", () => {
    const prompt = readProjectFile("seeds/prompts/create_from_template.md");

    expect(prompt).toContain("参考素材");
    expect(prompt).toContain("script_library_<genre>");
    expect(prompt).toContain("story_<genre>");
    expect(prompt).toContain("context_refs");
    expect(prompt).toContain("不要改写、删除或覆盖原始参考素材");
    expect(prompt).toContain("不能把参考素材当作 target_story_id");
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

  it("defines lianxian fragments as equal-weight host-caller dialogue scripts", () => {
    const registry = JSON.parse(readProjectFile("creative-spine.json")) as CreativeSpine;
    const createPrompt = readProjectFile("seeds/prompts/create_from_template.md");
    const optimizePrompt = readProjectFile("seeds/prompts/optimize_from_template.md");
    const lianxianCanonical = registry.lianxian?.canonical_artifacts[0];

    expect(lianxianCanonical).toMatchObject({
      key: "full_oral_script",
      label: "连线对话稿"
    });
    expect(lianxianCanonical?.description).toContain("主播");
    expect(lianxianCanonical?.description).toContain("连线用户");

    for (const prompt of [createPrompt, optimizePrompt]) {
      expect(prompt).toContain("主播：");
      expect(prompt).toContain("连线用户：");
      expect(prompt).toContain("相同权重");
      expect(prompt).toContain("出现次数相差不超过 1");
      expect(prompt).not.toContain("`full_oral_script` 是「照读口播」");
    }
  });

  it("validates lianxian dialogue fragments include both speaker labels", () => {
    const manifest = loadManifestFromFile(path.join(mumuRoot, "manifest.json"));
    const baseRecord = {
      id: "story-1",
      template_id: "template-1",
      outline: {
        arc: "先承接连线用户的犹豫，再由主播追问和拆解，最后共同落到可执行建议。",
        segments: [
          {
            no: 1,
            type: "hook",
            summary: "连线用户讲出困惑，主播接住情绪并追问关键事实。"
          }
        ]
      }
    };

    expect(validateRecord(manifest, "story_lianxian", {
      ...baseRecord,
      fragments: [
        {
          segment_no: 1,
          type: "full_oral_script",
          content: "主播：你先慢慢说，最卡住你的点是什么？\n连线用户：我怕自己一心软又回去了。\n主播：那我们先把他这次回头的动机拆开。\n连线用户：我也想知道这算不算真的改变。"
        }
      ]
    }).ok).toBe(true);

    const hostOnly = validateRecord(manifest, "story_lianxian", {
      ...baseRecord,
      fragments: [
        {
          segment_no: 1,
          type: "full_oral_script",
          content: "主播：你不要急，我们先拆问题。主播：这件事的关键不是他回来，而是他为什么回来。"
        }
      ]
    });

    expect(hostOnly.ok).toBe(false);
    if (!hostOnly.ok) {
      expect(hostOnly.errors.some((error) => error.instancePath.endsWith("/content"))).toBe(true);
    }
  });
});
