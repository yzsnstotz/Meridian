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

  it("pushes ready service-owned private archives without exposing the service token in git arguments", async () => {
    const root = makeRoot();
    writeJson(root, "structured/story_short_drama/s1.json", { id: "s1", title: "Story" });
    const pushCalls: unknown[] = [];
    const statusUpdates: unknown[] = [];
    const fetchCalls: Array<{ url: string; authorization?: string }> = [];
    const queue = new MumuMemoryGitSyncQueue({
      debounceMs: 0,
      maxFileBytes: 1024 * 1024,
      serviceGithubToken: "service-token-should-never-be-in-argv",
      fetchImpl: async (url: string, init?: { headers?: Record<string, string> }) => {
        fetchCalls.push({ url, authorization: init?.headers?.Authorization });
        return new Response(
          JSON.stringify({ name: "mumu-archive-u1", full_name: "yzsnstotz/mumu-archive-u1", private: true }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
      gitPush: async (request: unknown) => {
        pushCalls.push(request);
        return { ok: true };
      },
      statusReporter: async (status: unknown) => {
        statusUpdates.push(status);
      }
    } as never);

    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "direct_write",
      recordType: "story_short_drama",
      key: "s1",
      source: "ads_direct",
      remoteArchive: {
        push_enabled: true,
        state: "ready",
        owner: "yzsnstotz",
        repo_name: "mumu-archive-u1",
        repo_full_name: "yzsnstotz/mumu-archive-u1",
        private: true,
        status_callback_url: "http://127.0.0.1:3101/api/mumu/internal/archive-status/u1"
      }
    } as never);

    const result = await queue.flush(root) as unknown as {
      remote?: { status?: string; lastPushedCommit?: string | null };
    };

    expect(result?.remote?.status).toBe("pushed");
    expect(result?.remote?.lastPushedCommit).toMatch(/^[a-f0-9]{40}$/u);
    expect(pushCalls).toHaveLength(1);
    expect(JSON.stringify(pushCalls)).not.toContain("service-token-should-never-be-in-argv");
    expect(fetchCalls[0]?.url).toBe("https://api.github.com/repos/yzsnstotz/mumu-archive-u1");
    expect(fetchCalls[0]?.authorization).toBe("Bearer service-token-should-never-be-in-argv");
    expect(statusUpdates).toHaveLength(1);
    expect(JSON.stringify(statusUpdates[0])).toContain('"status":"pushed"');
  });

  it("keeps local commits active and reports blocked status when a remote archive is public", async () => {
    const root = makeRoot();
    writeJson(root, "structured/story_short_drama/s1.json", { id: "s1", title: "Story" });
    const pushCalls: unknown[] = [];
    const queue = new MumuMemoryGitSyncQueue({
      debounceMs: 0,
      maxFileBytes: 1024 * 1024,
      serviceGithubToken: "service-token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ name: "mumu-archive-u1", full_name: "yzsnstotz/mumu-archive-u1", private: false }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
      gitPush: async (request: unknown) => {
        pushCalls.push(request);
        return { ok: true };
      }
    } as never);

    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "direct_write",
      recordType: "story_short_drama",
      key: "s1",
      source: "ads_direct",
      remoteArchive: {
        push_enabled: true,
        state: "ready",
        owner: "yzsnstotz",
        repo_name: "mumu-archive-u1",
        repo_full_name: "yzsnstotz/mumu-archive-u1",
        private: true
      }
    } as never);

    const result = await queue.flush(root) as unknown as { remote?: { status?: string; blockedReason?: string } };

    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("1");
    expect(pushCalls).toHaveLength(0);
    expect(result.remote).toMatchObject({ status: "blocked", blockedReason: "public_repo" });
  });

  it("reports conflict_pending when the service-owned remote rejects a non-fast-forward push", async () => {
    const root = makeRoot();
    writeJson(root, "structured/story_short_drama/s1.json", { id: "s1", title: "Story" });
    const statusUpdates: unknown[] = [];
    const queue = new MumuMemoryGitSyncQueue({
      debounceMs: 0,
      maxFileBytes: 1024 * 1024,
      serviceGithubToken: "service-token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ name: "mumu-archive-u1", full_name: "yzsnstotz/mumu-archive-u1", private: true }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
      gitPush: async () => ({
        ok: false,
        conflict: true,
        stderr: "rejected non-fast-forward"
      }),
      statusReporter: async (status: unknown) => {
        statusUpdates.push(status);
      }
    } as never);

    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "direct_write",
      recordType: "story_short_drama",
      key: "s1",
      source: "ads_direct",
      remoteArchive: {
        push_enabled: true,
        state: "ready",
        owner: "yzsnstotz",
        repo_name: "mumu-archive-u1",
        repo_full_name: "yzsnstotz/mumu-archive-u1",
        private: true
      }
    } as never);

    const result = await queue.flush(root) as unknown as { remote?: { status?: string; lastErrorClass?: string } };

    expect(result.remote).toMatchObject({ status: "conflict_pending", lastErrorClass: "conflict_pending" });
    expect(statusUpdates).toHaveLength(1);
    expect(JSON.stringify(statusUpdates[0])).toContain('"status":"conflict_pending"');
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
