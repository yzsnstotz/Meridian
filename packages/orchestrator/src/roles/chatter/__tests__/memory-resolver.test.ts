import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryResolver, SandboxViolationError } from "../memory-resolver";
import { loadManifestFromTemplate } from "../manifest";

describe("MemoryResolver", () => {
  let root: string;
  let outside: string;
  let resolver: MemoryResolver;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-root-")));
    outside = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-outside-")));
    resolver = new MemoryResolver(root, loadManifestFromTemplate("flat-log"));
  });

  describe("constructor", () => {
    it("throws when memory_folder does not exist", () => {
      expect(
        () => new MemoryResolver(path.join(tmpdir(), "definitely-not-here-xyz"), loadManifestFromTemplate("flat-log"))
      ).toThrow();
    });
  });

  describe("resolveBinding", () => {
    it("resolves conversation_log with date + turn_id placeholders", () => {
      const p = resolver.resolveBinding("conversation_log", {
        date: "2026-05-19",
        turn_id: "abc"
      });
      expect(p.startsWith(root)).toBe(true);
      expect(p.endsWith(path.join("turns", "2026-05-19", "turn-abc.md"))).toBe(true);
    });

    it("rejects unknown binding name", () => {
      expect(() => resolver.resolveBinding("does_not_exist", {})).toThrow();
    });

    it("rejects when a required placeholder is missing", () => {
      expect(() => resolver.resolveBinding("conversation_log", { date: "2026-05-19" })).toThrow();
    });

    it("rejects when an expanded placeholder produces an escape", () => {
      // turns/<date>/turn-<turn_id>.md with date="../.." pops past root
      expect(() =>
        resolver.resolveBinding("conversation_log", { date: "../..", turn_id: "evil" })
      ).toThrow(SandboxViolationError);
    });

    it("rejects when a binding template would produce an absolute path", () => {
      const customManifest = {
        ...loadManifestFromTemplate("flat-log"),
        bindings: { evil: "/absolute/<x>.md" }
      };
      const r = new MemoryResolver(root, customManifest);
      expect(() => r.resolveBinding("evil", { x: "y" })).toThrow(SandboxViolationError);
    });
  });

  describe("resolveAbsoluteUserPath", () => {
    it("accepts a legitimate nested existing path inside root", () => {
      mkdirSync(path.join(root, "turns", "2026-05-19"), { recursive: true });
      const f = path.join(root, "turns", "2026-05-19", "turn-abc.md");
      writeFileSync(f, "hi");
      expect(() => resolver.resolveAbsoluteUserPath(f)).not.toThrow();
    });

    it("accepts a non-existent path under root (used for write targets)", () => {
      const f = path.join(root, "future", "file.md");
      expect(() => resolver.resolveAbsoluteUserPath(f)).not.toThrow();
    });

    it("rejects an absolute path outside root", () => {
      expect(() => resolver.resolveAbsoluteUserPath("/etc/passwd")).toThrow(SandboxViolationError);
    });

    it("rejects ../ escape", () => {
      expect(() => resolver.resolveAbsoluteUserPath(path.join(root, "../escape"))).toThrow(SandboxViolationError);
    });

    it("rejects a symlink whose target is outside root", () => {
      const link = path.join(root, "outside-link");
      symlinkSync(outside, link);
      const f = path.join(link, "x.md");
      expect(() => resolver.resolveAbsoluteUserPath(f)).toThrow(SandboxViolationError);
    });

    it("rejects a chain that lands inside root via a symlink and then escapes", () => {
      mkdirSync(path.join(root, "subdir"), { recursive: true });
      const linkA = path.join(root, "subdir", "link-out");
      symlinkSync(outside, linkA);
      const f = path.join(linkA, "nested.md");
      expect(() => resolver.resolveAbsoluteUserPath(f)).toThrow(SandboxViolationError);
    });

    it("rejects when the root itself is reached via a symlink target outside (defense in depth)", () => {
      // A user could pass `<root>/..` which path.resolve flattens to the parent — outside.
      expect(() => resolver.resolveAbsoluteUserPath(path.join(root, ".."))).toThrow(SandboxViolationError);
    });
  });
});
