import { describe, it, expect, beforeEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryResolver } from "../../../memory-resolver";
import { loadManifestFromFile } from "../../../manifest";
import {
  STRUCTURED_SKILL_NAMES,
  getStructuredToolDescriptors,
  makeStructuredSkills,
  registerStructuredSkills
} from "../index";

describe("structured skills", () => {
  let root: string;
  let resolver: MemoryResolver;
  let skills: ReturnType<typeof makeStructuredSkills>;

  beforeEach(() => {
    root = mkdtempSync(path.resolve(tmpdir(), "chatter-structured-"));
    const manifestPath = path.resolve(root, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        layers: "flat",
        index: "none",
        bindings: {},
        record_schemas: {
          story_short_drama: {
            type: "object",
            "x-indexed-fields": ["genre", "status"],
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              genre: { type: "string" },
              status: { type: "string" },
              episode_count: { type: "integer", minimum: 1 }
            },
            required: ["id", "title", "genre", "status", "episode_count"],
            additionalProperties: false
          }
        }
      })
    );
    resolver = new MemoryResolver(root, loadManifestFromFile(manifestPath));
    skills = makeStructuredSkills(resolver);
  });

  it("rejects schema violations before writing a record or index", async () => {
    const result = await skills.upsert("story_short_drama", "bad", {
      id: "bad",
      title: "Missing fields"
    });

    expect(result).toMatchObject({ error: "schema_violation" });
    expect(existsSync(path.resolve(root, "structured"))).toBe(false);
  });

  it("rejects path traversal keys through the memory resolver", async () => {
    const result = await skills.upsert("story_short_drama", "../escape", validStory({
      id: "escape",
      title: "Escape",
      genre: "urban",
      status: "draft"
    }));

    expect(result).toMatchObject({ error: "sandbox_violation" });
    expect(existsSync(path.resolve(root, "escape.json"))).toBe(false);
  });

  it("upserts, gets, and queries indexed plus non-indexed fields", async () => {
    await skills.upsert("story_short_drama", "s1", validStory({
      id: "s1",
      title: "Alpha",
      genre: "rebirth",
      status: "draft"
    }));
    await skills.upsert("story_short_drama", "s2", validStory({
      id: "s2",
      title: "Beta",
      genre: "rebirth",
      status: "published"
    }));
    await skills.upsert("story_short_drama", "s3", validStory({
      id: "s3",
      title: "Gamma",
      genre: "urban",
      status: "draft"
    }));

    await expect(skills.get("story_short_drama", "s2")).resolves.toMatchObject({
      record: validStory({ id: "s2", title: "Beta", genre: "rebirth", status: "published" })
    });

    const indexedAnd = await skills.query("story_short_drama", {
      and: [
        { field: "genre", op: "eq", value: "rebirth" },
        { field: "status", op: "eq", value: "published" }
      ]
    });
    expect(indexedAnd).toEqual({
      records: [validStory({ id: "s2", title: "Beta", genre: "rebirth", status: "published" })]
    });

    const bruteScan = await skills.query("story_short_drama", {
      field: "title",
      op: "in",
      value: ["Alpha", "Gamma"]
    });
    expect("records" in bruteScan).toBe(true);
    if (!("records" in bruteScan)) {
      throw new Error("expected records result");
    }
    expect(bruteScan.records.map((record: unknown) => (record as { id: string }).id).sort()).toEqual([
      "s1",
      "s3"
    ]);
  });

  it("delete removes the record and subsequent get returns not_found", async () => {
    await skills.upsert("story_short_drama", "s1", validStory({
      id: "s1",
      title: "Alpha",
      genre: "rebirth",
      status: "draft"
    }));

    await expect(skills.delete("story_short_drama", "s1")).resolves.toEqual({ deleted: true });
    await expect(skills.get("story_short_drama", "s1")).resolves.toEqual({ error: "not_found" });
  });

  it("list reads keys from _index.json as the source of truth", async () => {
    await skills.upsert("story_short_drama", "s1", validStory({
      id: "s1",
      title: "Alpha",
      genre: "rebirth",
      status: "draft"
    }));
    await skills.upsert("story_short_drama", "s2", validStory({
      id: "s2",
      title: "Beta",
      genre: "rebirth",
      status: "published"
    }));

    writeFileSync(
      path.resolve(root, "structured", "story_short_drama", "_index.json"),
      JSON.stringify({ keys: ["s2"], by_field: {} })
    );

    await expect(skills.list("story_short_drama")).resolves.toEqual({ keys: ["s2"] });
  });

  it("updates _index.json and record files via .tmp + rename writes", async () => {
    await skills.upsert("story_short_drama", "s1", validStory({
      id: "s1",
      title: "Alpha",
      genre: "rebirth",
      status: "draft"
    }));

    const index = JSON.parse(
      readFileSync(path.resolve(root, "structured", "story_short_drama", "_index.json"), "utf8")
    );
    expect(index.keys).toEqual(["s1"]);
    expect(index.by_field.genre.rebirth).toEqual(["s1"]);
    expect(existsSync(path.resolve(root, "structured", "story_short_drama", "s1.json.tmp"))).toBe(
      false
    );
    expect(existsSync(path.resolve(root, "structured", "story_short_drama", "_index.json.tmp"))).toBe(
      false
    );
  });

  it("emits structured.write after a valid upsert", async () => {
    const onEvent = vi.fn();
    skills = makeStructuredSkills(resolver, { onEvent });

    await skills.upsert("story_short_drama", "s1", validStory({
      id: "s1",
      title: "Alpha",
      genre: "rebirth",
      status: "draft"
    }));

    expect(onEvent).toHaveBeenCalledWith({
      name: "structured.write",
      type: "story_short_drama",
      key: "s1",
      record: validStory({ id: "s1", title: "Alpha", genre: "rebirth", status: "draft" })
    });
  });

  it("exports descriptors and a registry helper for structured agent tools", () => {
    expect(STRUCTURED_SKILL_NAMES).toEqual([
      "structured.upsert",
      "structured.get",
      "structured.query",
      "structured.delete",
      "structured.list"
    ]);
    expect(getStructuredToolDescriptors().map((descriptor) => descriptor.name)).toEqual(
      STRUCTURED_SKILL_NAMES
    );

    const registered: string[] = [];
    registerStructuredSkills(skills, {
      register(name, handler) {
        registered.push(name);
        expect(typeof handler).toBe("function");
      }
    });
    expect(registered).toEqual(STRUCTURED_SKILL_NAMES);
  });
});

function validStory(overrides: {
  id: string;
  title: string;
  genre: string;
  status: string;
}): Record<string, unknown> {
  return {
    ...overrides,
    episode_count: 24
  };
}
