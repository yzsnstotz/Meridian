import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryResolver } from "../memory-resolver";
import { makeMemorySkills } from "../memory-skills";
import { loadManifestFromTemplate } from "../manifest";

describe("memory skills (session mode = read+write)", () => {
  let root: string;
  let resolver: MemoryResolver;
  let skills: ReturnType<typeof makeMemorySkills>;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-skills-")));
    resolver = new MemoryResolver(root, loadManifestFromTemplate("flat-log"));
    skills = makeMemorySkills(resolver, "session");
  });

  describe("write", () => {
    it("persists content for a valid binding", async () => {
      const res = await skills.write({
        binding: "conversation_log",
        vars: { date: "2026-05-19", turn_id: "abc" },
        content: "hello"
      });
      expect(res.ok).toBe(true);
    });

    it("creates intermediate directories", async () => {
      const res = await skills.write({
        binding: "conversation_log",
        vars: { date: "2026-05-19", turn_id: "abc" },
        content: "hi"
      });
      expect(res.ok).toBe(true);
    });

    it("rejects sandbox escape via expanded placeholder", async () => {
      const res = await skills.write({
        binding: "conversation_log",
        vars: { date: "../..", turn_id: "evil" },
        content: "x"
      });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/sandbox|violation/i);
    });

    it("rejects unknown binding", async () => {
      const res = await skills.write({
        binding: "does_not_exist",
        vars: {},
        content: "x"
      });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Unknown binding/);
    });

    it("serializes concurrent writes to the same key (no torn file)", async () => {
      const target = { binding: "conversation_log", vars: { date: "d", turn_id: "t" } };
      const writers = Array.from({ length: 10 }, (_, i) =>
        skills.write({ ...target, content: `content-${i}` })
      );
      const results = await Promise.all(writers);
      expect(results.every((r) => r.ok)).toBe(true);
      const finalRead = await skills.read(target);
      expect(finalRead.ok).toBe(true);
      // The final content must equal SOME single write's content (no interleaving)
      expect(/^content-\d+$/.test(finalRead.content ?? "")).toBe(true);
    });
  });

  describe("read", () => {
    it("returns content for an existing key", async () => {
      const target = { binding: "conversation_log", vars: { date: "d", turn_id: "t" } };
      await skills.write({ ...target, content: "stored" });
      const res = await skills.read(target);
      expect(res.ok).toBe(true);
      expect(res.content).toBe("stored");
    });

    it("returns not_found for a missing key", async () => {
      const res = await skills.read({
        binding: "conversation_log",
        vars: { date: "missing", turn_id: "x" }
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("not_found");
    });

    it("rejects sandbox escape via expanded placeholder", async () => {
      const res = await skills.read({
        binding: "conversation_log",
        vars: { date: "../..", turn_id: "evil" }
      });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/sandbox|violation/i);
    });
  });

  describe("list", () => {
    it("returns entries under the resolved directory", async () => {
      mkdirSync(path.join(root, "turns", "d"), { recursive: true });
      writeFileSync(path.join(root, "turns", "d", "turn-a.md"), "a");
      writeFileSync(path.join(root, "turns", "d", "turn-b.md"), "b");
      const res = await skills.list({
        binding: "conversation_log",
        vars: { date: "d", turn_id: "ignored" }
      });
      expect(res.ok).toBe(true);
      expect([...(res.entries ?? [])].sort()).toEqual(["turn-a.md", "turn-b.md"]);
    });

    it("returns empty entries when directory does not exist", async () => {
      const res = await skills.list({
        binding: "conversation_log",
        vars: { date: "absent", turn_id: "x" }
      });
      expect(res.ok).toBe(true);
      expect(res.entries).toEqual([]);
    });
  });
});

describe("memory skills (stateless mode = read-only)", () => {
  let root: string;
  let resolver: MemoryResolver;
  let skills: ReturnType<typeof makeMemorySkills>;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-skills-")));
    resolver = new MemoryResolver(root, loadManifestFromTemplate("flat-log"));
    skills = makeMemorySkills(resolver, "stateless");
  });

  it("rejects write with read_only_mode", async () => {
    const res = await skills.write({
      binding: "conversation_log",
      vars: { date: "d", turn_id: "t" },
      content: "nope"
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("read_only_mode");
  });

  it("allows read", async () => {
    // Pre-seed file
    mkdirSync(path.join(root, "turns", "d"), { recursive: true });
    writeFileSync(path.join(root, "turns", "d", "turn-t.md"), "seeded");
    const res = await skills.read({
      binding: "conversation_log",
      vars: { date: "d", turn_id: "t" }
    });
    expect(res.ok).toBe(true);
    expect(res.content).toBe("seeded");
  });

  it("allows list", async () => {
    const res = await skills.list({
      binding: "conversation_log",
      vars: { date: "anywhere", turn_id: "x" }
    });
    expect(res.ok).toBe(true);
  });
});
