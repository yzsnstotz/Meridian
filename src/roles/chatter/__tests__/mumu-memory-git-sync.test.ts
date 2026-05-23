import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MumuMemoryGitSyncQueue } from "../mumu-memory-git-sync";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true }));
  }
});

describe("MumuMemoryGitSyncQueue", () => {
  it("initializes a local git repo and commits only durable user memory paths", async () => {
    const root = makeRoot();
    writeJson(root, "structured/story_short_drama/s1.json", { id: "s1", title: "Story" });
    writeJson(root, "structured/template_douyin/t1.json", { id: "t1", title: "Template" });
    writeJson(root, "structured/style_variety/profile.json", { id: "profile", tone: "warm" });
    writeText(root, "turns/2026-05-24/turn-0001.md", "hello");
    writeText(root, ".chatter-state/state.json", "{}");
    writeText(root, ".chatter-sandbox/scratch.txt", "scratch");

    const queue = new MumuMemoryGitSyncQueue({ debounceMs: 0, maxFileBytes: 1024 * 1024 });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "story_short_drama",
      key: "s1",
      source: "chatter"
    });
    await queue.flush(root);

    expect(existsSync(path.join(root, ".git"))).toBe(true);
    expect(readFileSync(path.join(root, ".gitignore"), "utf8")).toContain("!/structured/");
    expect(git(root, "log", "--oneline")).toContain("mumu memory structured write");
    expect(git(root, "ls-files").split("\n").filter(Boolean).sort()).toEqual([
      ".gitignore",
      "structured/story_short_drama/s1.json",
      "structured/style_variety/profile.json",
      "structured/template_douyin/t1.json",
      "turns/2026-05-24/turn-0001.md"
    ]);
  });

  it("creates debounced subsequent commits for the same user root", async () => {
    const root = makeRoot();
    writeJson(root, "structured/story_short_drama/s1.json", { id: "s1", title: "One" });
    const queue = new MumuMemoryGitSyncQueue({ debounceMs: 0, maxFileBytes: 1024 * 1024 });

    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "story_short_drama",
      key: "s1",
      source: "chatter"
    });
    await queue.flush(root);

    writeJson(root, "structured/story_short_drama/s1.json", { id: "s1", title: "Two" });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "story_short_drama",
      key: "s1",
      source: "chatter"
    });
    await queue.flush(root);

    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("2");
  });

  it("commits deletion events as durable git history", async () => {
    const root = makeRoot();
    const recordPath = "structured/story_short_drama/s1.json";
    writeJson(root, recordPath, { id: "s1", title: "One" });
    const queue = new MumuMemoryGitSyncQueue({ debounceMs: 0, maxFileBytes: 1024 * 1024 });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "story_short_drama",
      key: "s1",
      source: "chatter"
    });
    await queue.flush(root);

    rmSync(path.join(root, recordPath));
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_delete",
      recordType: "story_short_drama",
      key: "s1",
      source: "chatter"
    });
    await queue.flush(root);

    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("2");
    expect(git(root, "ls-files")).not.toContain(recordPath);
    expect(git(root, "show", "--name-status", "--format=", "HEAD")).toContain(`D\t${recordPath}`);
  });

  it("excludes raw uploads, binary exports, caches, and files above the threshold", async () => {
    const root = makeRoot();
    writeJson(root, "structured/story_short_drama/s1.json", { id: "s1", title: "Story" });
    writeText(root, "turns/2026-05-24/turn-0001.md", "x".repeat(80));
    writeText(root, "turns/2026-05-24/oversized.md", "x".repeat(200));
    writeText(root, "structured/story_short_drama/export.zip", "zip-ish");
    writeText(root, "structured/story_short_drama/.cache/cache.json", "{}");
    writeText(root, "structured/story_short_drama/upload.bin", "\u0000\u0001\u0002");

    const queue = new MumuMemoryGitSyncQueue({ debounceMs: 0, maxFileBytes: 100 });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "turn_write",
      source: "chatter"
    });
    const result = await queue.flush(root);

    expect(result?.metadata.large_file_excluded_count).toBeGreaterThanOrEqual(1);
    expect(git(root, "ls-files").split("\n").filter(Boolean).sort()).toEqual([
      ".gitignore",
      "structured/story_short_drama/s1.json",
      "turns/2026-05-24/turn-0001.md"
    ]);
  });
});

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mumu-memory-git-sync-"));
  roots.push(root);
  return root;
}

function writeJson(root: string, relativePath: string, value: unknown): void {
  writeText(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
