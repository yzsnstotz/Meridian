import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ChatterManifestSchema,
  InvalidRecordSchemaError,
  hasRecordType,
  loadManifestFromTemplate,
  loadManifestFromFile,
  validateRecord
} from "../manifest";

describe("ChatterManifestSchema", () => {
  it("parses a valid manifest", () => {
    const parsed = ChatterManifestSchema.parse({
      version: 1,
      layers: "flat",
      index: "none",
      bindings: { conversation_log: "turns/<date>/turn-<turn_id>.md" }
    });
    expect(parsed.layers).toBe("flat");
    expect(parsed.bindings.conversation_log).toBe("turns/<date>/turn-<turn_id>.md");
  });

  it("accepts record_schemas with jsonSchema extension metadata", () => {
    const parsed = ChatterManifestSchema.parse({
      version: 1,
      layers: "flat",
      index: "none",
      bindings: { conversation_log: "turns/<date>/turn-<turn_id>.md" },
      record_schemas: {
        template_short_drama: {
          type: "object",
          "x-indexed-fields": ["genre"],
          properties: {
            title: { type: "string" },
            genre: { type: "string" }
          },
          required: ["title"],
          additionalProperties: false
        }
      }
    });

    expect(parsed.record_schemas?.template_short_drama).toMatchObject({
      type: "object",
      "x-indexed-fields": ["genre"]
    });
  });

  it("accepts background_triggers with structured-upsert fires_on and throttle", () => {
    const parsed = ChatterManifestSchema.parse({
      version: 1,
      layers: "flat",
      index: "none",
      bindings: { conversation_log: "turns/<turn_id>.md" },
      record_schemas: {
        story_short_drama: {
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
        fires_on: { type: "after_structured_upsert", record_type: "story_short_drama" },
        throttle: { min_records_since_last_fire: 3, min_interval: "10m" },
        action: { system_prompt_id: "style_observe" }
      }]
    });

    expect(parsed.background_triggers?.[0]).toMatchObject({
      name: "style_observe_after_stories",
      fires_on: { type: "after_structured_upsert", record_type: "story_short_drama" },
      action: { system_prompt_id: "style_observe" }
    });
  });

  it("rejects unknown layer kind", () => {
    expect(() => ChatterManifestSchema.parse({
      version: 1,
      layers: "weird",
      index: "none",
      bindings: {}
    })).toThrow();
  });

  it("rejects unknown index kind", () => {
    expect(() => ChatterManifestSchema.parse({
      version: 1,
      layers: "flat",
      index: "sqlite",
      bindings: {}
    })).toThrow();
  });

  it("rejects unknown version", () => {
    expect(() => ChatterManifestSchema.parse({
      version: 2,
      layers: "flat",
      index: "none",
      bindings: {}
    })).toThrow();
  });

  it("rejects extra top-level fields (strict)", () => {
    expect(() => ChatterManifestSchema.parse({
      version: 1,
      layers: "flat",
      index: "none",
      bindings: {},
      extra: "nope"
    })).toThrow();
  });

  it("rejects non-string binding value", () => {
    expect(() => ChatterManifestSchema.parse({
      version: 1,
      layers: "flat",
      index: "none",
      bindings: { conversation_log: 123 }
    })).toThrow();
  });
});

describe("loadManifestFromTemplate", () => {
  it("loads flat-log: layers=flat, index=none, has conversation_log binding", () => {
    const m = loadManifestFromTemplate("flat-log");
    expect(m.layers).toBe("flat");
    expect(m.index).toBe("none");
    expect(m.bindings.conversation_log).toBeDefined();
  });

  it("loads topic-tree: layers=tree, has topic_entry binding", () => {
    const m = loadManifestFromTemplate("topic-tree");
    expect(m.layers).toBe("tree");
    expect(m.bindings.topic_entry).toBeDefined();
  });

  it("loads indexed-kb: layers=tree, index=json, has kb_entry binding", () => {
    const m = loadManifestFromTemplate("indexed-kb");
    expect(m.layers).toBe("tree");
    expect(m.index).toBe("json");
    expect(m.bindings.kb_entry).toBeDefined();
  });

  it("templates always pass their own schema validation", () => {
    expect(() => loadManifestFromTemplate("flat-log")).not.toThrow();
    expect(() => loadManifestFromTemplate("topic-tree")).not.toThrow();
    expect(() => loadManifestFromTemplate("indexed-kb")).not.toThrow();
  });
});

describe("loadManifestFromFile", () => {
  it("reads and validates a JSON manifest", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chatter-manifest-"));
    const file = path.join(dir, "m.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        layers: "flat",
        index: "none",
        bindings: { conversation_log: "turns/<turn_id>.md" }
      })
    );
    const m = loadManifestFromFile(file);
    expect(m.layers).toBe("flat");
  });

  it("rejects a schema-invalid manifest", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chatter-manifest-"));
    const file = path.join(dir, "m.json");
    writeFileSync(file, JSON.stringify({ version: 2 }));
    expect(() => loadManifestFromFile(file)).toThrow();
  });

  it("rejects a non-JSON file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chatter-manifest-"));
    const file = path.join(dir, "m.json");
    writeFileSync(file, "this is not json at all");
    expect(() => loadManifestFromFile(file)).toThrow();
  });

  it("rejects a manifest with an unknown binding shape", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chatter-manifest-"));
    const file = path.join(dir, "m.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        layers: "flat",
        index: "none",
        bindings: { conversation_log: null }
      })
    );
    expect(() => loadManifestFromFile(file)).toThrow();
  });

  it("compiles record_schemas and validates records with structured errors", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chatter-manifest-"));
    const file = path.join(dir, "m.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        layers: "flat",
        index: "none",
        bindings: { conversation_log: "turns/<turn_id>.md" },
        record_schemas: {
          template_short_drama: {
            type: "object",
            properties: {
              title: { type: "string" },
              episode_count: { type: "integer", minimum: 1 }
            },
            required: ["title", "episode_count"],
            additionalProperties: false
          }
        }
      })
    );

    const manifest = loadManifestFromFile(file);

    expect(hasRecordType(manifest, "template_short_drama")).toBe(true);
    expect(hasRecordType(manifest, "unknown")).toBe(false);

    const valid = validateRecord(manifest, "template_short_drama", {
      title: "Rebirth Contract",
      episode_count: 12
    });
    expect(valid).toEqual({
      ok: true,
      value: { title: "Rebirth Contract", episode_count: 12 }
    });

    const invalid = validateRecord(manifest, "template_short_drama", { episode_count: 0 });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors.length).toBeGreaterThan(0);
      expect(invalid.errors.map((error) => error.instancePath)).toContain("");
      expect(invalid.errors.map((error) => error.instancePath)).toContain("/episode_count");
    }
  });

  it("keeps compiled record validators cached on the manifest", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chatter-manifest-"));
    const file = path.join(dir, "m.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        layers: "flat",
        index: "none",
        bindings: { conversation_log: "turns/<turn_id>.md" },
        record_schemas: {
          story_short_drama: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false
          }
        }
      })
    );

    const manifest = loadManifestFromFile(file);
    const cachedBefore = manifest.compiledRecordSchemas?.get("story_short_drama");
    validateRecord(manifest, "story_short_drama", { title: "Pilot" });
    validateRecord(manifest, "story_short_drama", { title: "Finale" });

    expect(cachedBefore).toBeDefined();
    expect(manifest.compiledRecordSchemas?.get("story_short_drama")).toBe(cachedBefore);
  });

  it("rejects record_schemas entries missing a top-level type", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chatter-manifest-"));
    const file = path.join(dir, "m.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        layers: "flat",
        index: "none",
        bindings: { conversation_log: "turns/<turn_id>.md" },
        record_schemas: {
          template_short_drama: {
            properties: { title: { type: "string" } }
          }
        }
      })
    );

    expect(() => loadManifestFromFile(file)).toThrow(InvalidRecordSchemaError);
    expect(() => loadManifestFromFile(file)).toThrow("template_short_drama");
  });

  it("rejects circular local refs in record_schemas", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chatter-manifest-"));
    const file = path.join(dir, "m.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        layers: "flat",
        index: "none",
        bindings: { conversation_log: "turns/<turn_id>.md" },
        record_schemas: {
          template_short_drama: {
            type: "object",
            properties: {
              parent: { $ref: "#" }
            }
          }
        }
      })
    );

    expect(() => loadManifestFromFile(file)).toThrow(InvalidRecordSchemaError);
    expect(() => loadManifestFromFile(file)).toThrow("template_short_drama");
  });
});
