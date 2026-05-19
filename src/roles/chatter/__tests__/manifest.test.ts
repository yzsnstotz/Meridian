import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ChatterManifestSchema,
  loadManifestFromTemplate,
  loadManifestFromFile
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
});
