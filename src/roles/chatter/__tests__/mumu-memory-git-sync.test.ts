import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MumuMemoryGitSyncQueue } from "../mumu-memory-git-sync";
import {
  createMumuMemorySavepoint,
  readMumuMemorySnapshot,
  listMumuMemorySavepoints,
  restoreMumuMemorySavepoint
} from "../mumu-memory-savepoints";
import {
  renderChatterPrometheusMetrics,
  resetChatterObservabilityForTests,
  snapshotMumuArchivePressureCounters,
  snapshotMumuGitCommitCounters,
  snapshotMumuGitPushCounters
} from "../observability";

const roots: string[] = [];

afterEach(async () => {
  resetChatterObservabilityForTests();
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

  it("records content-free git commit and archive pressure telemetry", async () => {
    const root = makeRoot();
    writeJson(root, "structured/story_short_drama/s1.json", { id: "s1", title: "Story" });
    writeText(root, "turns/2026-05-24/turn-0001.md", "x".repeat(80));
    writeText(root, "turns/2026-05-24/oversized.md", "x".repeat(200));

    const queue = new MumuMemoryGitSyncQueue({ debounceMs: 0, maxFileBytes: 100 });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "turn_write",
      source: "chatter"
    });
    await queue.flush(root);

    expect(snapshotMumuGitCommitCounters()).toEqual({ "turn_write|committed": 1 });
    const pressureCounters = snapshotMumuArchivePressureCounters();
    expect(pressureCounters).toMatchObject({
      "largest_tracked_file_size|le_1kb": 1,
      "turn_log_size|le_1kb": 1,
      "large_file_excluded_total|threshold": 1
    });
    const repoSizeBuckets = Object.entries(pressureCounters)
      .filter(([key]) => key.startsWith("repo_size|"));
    expect(repoSizeBuckets).toHaveLength(1);
    expect(repoSizeBuckets[0]?.[1]).toBe(1);

    const metrics = renderChatterPrometheusMetrics();
    expect(metrics).toContain('mumu_git_commit_total{kind="turn_write",status="committed"} 1');
    expect(metrics).toMatch(/mumu_archive_repo_size_bucket\{bucket="(?:le|gt)_[^"]+"\} 1/u);
    expect(metrics).toContain('mumu_archive_large_file_excluded_total{reason="threshold"} 1');
    expect(metrics).not.toContain(root);
    expect(metrics).not.toContain("u1");
    expect(metrics).not.toContain("s1");
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
    expect(snapshotMumuGitPushCounters()).toEqual({ pushed: 1 });
  });

  it("pushes annotated savepoint refs with metadata while keeping labels out of ref names", async () => {
    const root = makeRoot();
    writeJson(root, "structured/story_short_drama/s1.json", { id: "s1", title: "Story" });
    const pushCalls: Array<{ refspecs: string[] }> = [];
    const queue = new MumuMemoryGitSyncQueue({
      debounceMs: 0,
      maxFileBytes: 1024 * 1024,
      serviceGithubToken: "service-token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ name: "mumu-archive-u1", full_name: "yzsnstotz/mumu-archive-u1", private: true }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
      gitPush: async (request: { refspecs: string[] }) => {
        pushCalls.push(request);
        return { ok: true };
      }
    } as never);

    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "story_short_drama",
      key: "s1",
      source: "chatter"
    });
    await queue.flush(root);

    const savepoint = await createMumuMemorySavepoint(root, {
      label: "private draft label",
      id: "sp-test-one",
      now: () => new Date("2026-05-24T03:04:05.000Z")
    });

    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "direct_write",
      recordType: "savepoint",
      key: savepoint.id,
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
    await queue.flush(root);

    expect(savepoint.label).toBe("private draft label");
    expect(savepoint.ref_name).toBe("refs/tags/mumu-savepoints/sp-test-one");
    expect(savepoint.ref_name).not.toContain("private");
    expect(git(root, "tag", "-n99", "mumu-savepoints/sp-test-one")).toContain("private draft label");
    expect(pushCalls.at(-1)?.refspecs).toContain("refs/tags/mumu-savepoints/sp-test-one:refs/tags/mumu-savepoints/sp-test-one");
  });

  it("serializes project savepoint metadata and filters snapshots to included paths", async () => {
    const root = makeRoot();
    const projectStoryPath = "structured/story_douyin/story-project-a.json";
    const otherStoryPath = "structured/story_douyin/story-project-b.json";
    writeJson(root, projectStoryPath, { id: "story-project-a", title: "Project A" });
    writeJson(root, otherStoryPath, { id: "story-project-b", title: "Project B" });
    const queue = new MumuMemoryGitSyncQueue({ debounceMs: 0, maxFileBytes: 1024 * 1024 });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "story_douyin",
      key: "story-project-a",
      source: "chatter"
    });
    await queue.flush(root);

    const savepoint = await createMumuMemorySavepoint(root, {
      label: "Project A version",
      id: "sp-project-a",
      now: () => new Date("2026-05-24T03:04:05.000Z"),
      metadata: {
        scope_kind: "project",
        project_id: "project-a",
        current_story_id: "story-project-a",
        project_name: "日本生活 AI 日记",
        project_description: "记录一个普通人在日本边工作边生活。",
        genre: "douyin",
        entry_source: "blank",
        created_from_surface: "story_create_workbench",
        included_paths: [projectStoryPath]
      }
    });

    const tagContents = git(root, "tag", "-n99", "mumu-savepoints/sp-project-a");
    expect(tagContents).toContain('"scope_kind":"project"');
    expect(tagContents).toContain('"project_id":"project-a"');
    expect(tagContents).toContain(projectStoryPath);
    expect(await listMumuMemorySavepoints(root)).toEqual([
      expect.objectContaining({
        id: savepoint.id,
        scope_kind: "project",
        project_id: "project-a",
        current_story_id: "story-project-a",
        project_name: "日本生活 AI 日记",
        genre: "douyin",
        entry_source: "blank",
        created_from_surface: "story_create_workbench",
        included_paths: [projectStoryPath]
      })
    ]);

    const snapshot = await readMumuMemorySnapshot(root, savepoint.id);
    expect(snapshot.savepoint.scope_kind).toBe("project");
    expect(snapshot.records.map((record) => record.path)).toEqual([projectStoryPath]);
  });

  it("keeps legacy savepoints account-scoped and restores project savepoints only from included paths", async () => {
    const root = makeRoot();
    const projectStoryPath = "structured/story_douyin/story-project-a.json";
    const otherStoryPath = "structured/story_douyin/story-project-b.json";
    writeJson(root, projectStoryPath, { id: "story-project-a", title: "Old Project A" });
    writeJson(root, otherStoryPath, { id: "story-project-b", title: "Old Project B" });
    const queue = new MumuMemoryGitSyncQueue({ debounceMs: 0, maxFileBytes: 1024 * 1024 });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "story_douyin",
      key: "story-project-a",
      source: "chatter"
    });
    await queue.flush(root);

    const legacy = await createMumuMemorySavepoint(root, {
      id: "sp-legacy-account",
      now: () => new Date("2026-05-24T03:04:05.000Z")
    });
    const project = await createMumuMemorySavepoint(root, {
      id: "sp-project-only",
      now: () => new Date("2026-05-24T03:04:06.000Z"),
      metadata: {
        scope_kind: "project",
        project_id: "project-a",
        current_story_id: "story-project-a",
        genre: "douyin",
        created_from_surface: "story_create_workbench",
        included_paths: [projectStoryPath]
      }
    });

    writeJson(root, projectStoryPath, { id: "story-project-a", title: "Current Project A" });
    writeJson(root, otherStoryPath, { id: "story-project-b", title: "Current Project B" });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "story_douyin",
      key: "story-project-a",
      source: "chatter"
    });
    await queue.flush(root);

    const legacySnapshot = await readMumuMemorySnapshot(root, legacy.id);
    expect(legacySnapshot.savepoint).toMatchObject({
      scope_kind: "account",
      project_id: null,
      included_paths: []
    });

    const result = await restoreMumuMemorySavepoint(root, project.id, { scope: { kind: "root" } });

    expect(result.scope).toEqual({ kind: "root" });
    expect(result.restored_paths).toEqual([projectStoryPath]);
    expect(result.deleted_paths).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(root, projectStoryPath), "utf8"))).toMatchObject({
      title: "Old Project A"
    });
    expect(JSON.parse(readFileSync(path.join(root, otherStoryPath), "utf8"))).toMatchObject({
      title: "Current Project B"
    });
  });

  it("lists, reads, and plans record-type restore from project savepoint metadata", async () => {
    const root = makeRoot();
    const projectStoryPath = "structured/story_douyin/story-project-a.json";
    const otherProjectStoryPath = "structured/story_douyin/story-project-b.json";
    const stylePath = "structured/style_douyin/project-style.json";
    writeJson(root, projectStoryPath, { id: "story-project-a", title: "Project A v1" });
    writeJson(root, otherProjectStoryPath, { id: "story-project-b", title: "Project B v1" });
    writeJson(root, stylePath, {
      user_authored: { likes: ["warm"], dislikes: [], tone_keywords: ["bright"], notes: "project style" },
      agent_observed: { recurring_motifs: ["street"], avoided_patterns: [] }
    });
    const queue = new MumuMemoryGitSyncQueue({ debounceMs: 0, maxFileBytes: 1024 * 1024 });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "story_douyin",
      key: "story-project-a",
      source: "chatter"
    });
    await queue.flush(root);

    const savepoint = await createMumuMemorySavepoint(root, {
      id: "sp-project-restore-plan",
      now: () => new Date("2026-05-24T03:04:05.000Z"),
      metadata: {
        scope_kind: "project",
        project_id: "project-a",
        current_story_id: "story-project-a",
        project_name: "Project A",
        genre: "douyin",
        entry_source: "template",
        created_from_surface: "story_create_workbench",
        included_paths: [stylePath, projectStoryPath]
      }
    });

    writeJson(root, projectStoryPath, { id: "story-project-a", title: "Project A current" });
    writeJson(root, otherProjectStoryPath, { id: "story-project-b", title: "Project B current" });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "story_douyin",
      key: "story-project-a",
      source: "chatter"
    });
    await queue.flush(root);

    const listed = await listMumuMemorySavepoints(root);
    expect(listed).toEqual([
      expect.objectContaining({
        id: savepoint.id,
        scope_kind: "project",
        project_id: "project-a",
        current_story_id: "story-project-a",
        project_name: "Project A",
        genre: "douyin",
        entry_source: "template",
        created_from_surface: "story_create_workbench",
        included_paths: [projectStoryPath, stylePath]
      })
    ]);

    const snapshot = await readMumuMemorySnapshot(root, savepoint.id);
    expect(snapshot.records.map((record) => record.path).sort()).toEqual([projectStoryPath, stylePath]);

    const result = await restoreMumuMemorySavepoint(root, savepoint.id, {
      scope: { kind: "record_type", record_type: "story_douyin" }
    });

    expect(result.restored_paths).toEqual([projectStoryPath]);
    expect(result.deleted_paths).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(root, projectStoryPath), "utf8"))).toMatchObject({
      title: "Project A v1"
    });
    expect(JSON.parse(readFileSync(path.join(root, otherProjectStoryPath), "utf8"))).toMatchObject({
      title: "Project B current"
    });
    expect(readFileSync(path.join(root, stylePath), "utf8")).toContain("project style");
  });

  it("reads an older savepoint snapshot with first-class style changes without mutating current files", async () => {
    const root = makeRoot();
    const stylePath = "structured/style_douyin/u1.json";
    writeJson(root, stylePath, {
      user_authored: {
        likes: ["old hook"],
        dislikes: ["old drag"],
        tone_keywords: ["old tone"],
        notes: "old notes"
      },
      agent_observed: {
        recurring_motifs: ["old motif"],
        avoided_patterns: ["old avoid"]
      }
    });
    writeJson(root, "structured/story_douyin/s1.json", { id: "s1", title: "Old story" });
    const queue = new MumuMemoryGitSyncQueue({ debounceMs: 0, maxFileBytes: 1024 * 1024 });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "style_douyin",
      key: "u1",
      source: "chatter"
    });
    await queue.flush(root);
    const savepoint = await createMumuMemorySavepoint(root, {
      label: "before style edit",
      id: "sp-style-before",
      now: () => new Date("2026-05-24T03:04:05.000Z")
    });

    writeJson(root, stylePath, {
      user_authored: {
        likes: ["new hook"],
        dislikes: ["new drag"],
        tone_keywords: ["new tone"],
        notes: "new notes"
      },
      agent_observed: {
        recurring_motifs: ["new motif"],
        avoided_patterns: ["new avoid"]
      }
    });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "style_douyin",
      key: "u1",
      source: "chatter"
    });
    await queue.flush(root);

    const snapshot = await readMumuMemorySnapshot(root, savepoint.id);

    expect(readFileSync(path.join(root, stylePath), "utf8")).toContain("new hook");
    expect(snapshot.savepoint.id).toBe("sp-style-before");
    expect(snapshot.records.some((record) => record.type === "story_douyin" && record.key === "s1")).toBe(true);
    expect(snapshot.style_records).toHaveLength(1);
    expect(snapshot.style_records[0]).toMatchObject({
      type: "style_douyin",
      key: "u1",
      genre: "douyin",
      user_authored: {
        likes: ["old hook"],
        dislikes: ["old drag"],
        tone_keywords: ["old tone"],
        notes: "old notes"
      },
      agent_observed: {
        recurring_motifs: ["old motif"],
        avoided_patterns: ["old avoid"]
      }
    });
    expect(snapshot.style_changes).toHaveLength(1);
    expect(snapshot.style_changes[0]).toMatchObject({
      status: "modified",
      type: "style_douyin",
      key: "u1",
      before: {
        user_authored: {
          likes: ["old hook"]
        }
      },
      after: {
        user_authored: {
          likes: ["new hook"]
        }
      }
    });
    expect(await listMumuMemorySavepoints(root)).toEqual([
      expect.objectContaining({
        id: "sp-style-before",
        label: "before style edit",
        commit_sha: savepoint.commit_sha,
        short_commit: savepoint.commit_sha.slice(0, 12),
        restore_available: true
      })
    ]);
  });

  it("restores a selected story record as a new current commit without deleting other records", async () => {
    const root = makeRoot();
    const storyPath = "structured/story_douyin/s1.json";
    const otherStoryPath = "structured/story_douyin/s2.json";
    writeJson(root, storyPath, { id: "s1", title: "Original story" });
    writeJson(root, otherStoryPath, { id: "s2", title: "Other story" });
    const queue = new MumuMemoryGitSyncQueue({ debounceMs: 0, maxFileBytes: 1024 * 1024 });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "story_douyin",
      key: "s1",
      source: "chatter"
    });
    await queue.flush(root);
    const savepoint = await createMumuMemorySavepoint(root, {
      id: "sp-story-before",
      now: () => new Date("2026-05-24T03:04:05.000Z")
    });

    writeJson(root, storyPath, { id: "s1", title: "Current story" });
    writeJson(root, otherStoryPath, { id: "s2", title: "Other current story" });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "story_douyin",
      key: "s1",
      source: "chatter"
    });
    await queue.flush(root);

    const result = await restoreMumuMemorySavepoint(root, savepoint.id, {
      scope: { kind: "record", record_type: "story_douyin", key: "s1" }
    });

    expect(result.previous_head_sha).not.toBe(savepoint.commit_sha);
    expect(result.restore_commit_sha).toMatch(/^[a-f0-9]{40}$/u);
    expect(result.restored_paths).toEqual([storyPath]);
    expect(result.deleted_paths).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(root, storyPath), "utf8"))).toMatchObject({ title: "Original story" });
    expect(JSON.parse(readFileSync(path.join(root, otherStoryPath), "utf8"))).toMatchObject({ title: "Other current story" });
    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("3");
    expect(git(root, "log", "--oneline", "-1")).toContain("mumu memory restore savepoint sp-story-before");
    expect(git(root, "cat-file", "-t", savepoint.commit_sha).trim()).toBe("commit");
  });

  it("restores style records and creates a safety commit for uncommitted current state", async () => {
    const root = makeRoot();
    const stylePath = "structured/style_douyin/u1.json";
    writeJson(root, stylePath, {
      user_authored: { likes: ["savepoint style"], dislikes: [], tone_keywords: ["old"], notes: "old" },
      agent_observed: { recurring_motifs: ["motif"], avoided_patterns: [] }
    });
    const queue = new MumuMemoryGitSyncQueue({ debounceMs: 0, maxFileBytes: 1024 * 1024 });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "style_douyin",
      key: "u1",
      source: "chatter"
    });
    await queue.flush(root);
    const savepoint = await createMumuMemorySavepoint(root, { id: "sp-style-restore" });

    writeJson(root, stylePath, {
      user_authored: { likes: ["unsaved style"], dislikes: [], tone_keywords: ["new"], notes: "new" },
      agent_observed: { recurring_motifs: ["motif"], avoided_patterns: [] }
    });

    const result = await restoreMumuMemorySavepoint(root, savepoint.id, {
      scope: { kind: "record", record_type: "style_douyin", key: "u1" }
    });

    expect(result.safety_commit_sha).toMatch(/^[a-f0-9]{40}$/u);
    expect(JSON.parse(readFileSync(path.join(root, stylePath), "utf8"))).toMatchObject({
      user_authored: { likes: ["savepoint style"] }
    });
    expect(git(root, "show", `${result.safety_commit_sha}:${stylePath}`)).toContain("unsaved style");
    expect(git(root, "log", "--oneline", "-2")).toContain("mumu memory safety before restore");
    expect(git(root, "log", "--oneline", "-1")).toContain("mumu memory restore savepoint sp-style-restore");
  });

  it("restores a record type scope by removing current records missing from the savepoint", async () => {
    const root = makeRoot();
    writeJson(root, "structured/story_douyin/s1.json", { id: "s1", title: "Original" });
    const queue = new MumuMemoryGitSyncQueue({ debounceMs: 0, maxFileBytes: 1024 * 1024 });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "story_douyin",
      key: "s1",
      source: "chatter"
    });
    await queue.flush(root);
    const savepoint = await createMumuMemorySavepoint(root, { id: "sp-type-restore" });

    writeJson(root, "structured/story_douyin/s1.json", { id: "s1", title: "Current" });
    writeJson(root, "structured/story_douyin/s2.json", { id: "s2", title: "New current only" });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "story_douyin",
      key: "s2",
      source: "chatter"
    });
    await queue.flush(root);

    const result = await restoreMumuMemorySavepoint(root, savepoint.id, {
      scope: { kind: "record_type", record_type: "story_douyin" }
    });

    expect(result.restored_paths).toContain("structured/story_douyin/s1.json");
    expect(result.deleted_paths).toContain("structured/story_douyin/s2.json");
    expect(existsSync(path.join(root, "structured/story_douyin/s2.json"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(root, "structured/story_douyin/s1.json"), "utf8"))).toMatchObject({
      title: "Original"
    });
  });

  it("restores a structured-only root savepoint when turns never existed", async () => {
    const root = makeRoot();
    const storyPath = "structured/story_douyin/s1.json";
    const currentOnlyPath = "structured/story_douyin/s2.json";
    writeJson(root, storyPath, { id: "s1", title: "Original" });
    const queue = new MumuMemoryGitSyncQueue({ debounceMs: 0, maxFileBytes: 1024 * 1024 });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "story_douyin",
      key: "s1",
      source: "chatter"
    });
    await queue.flush(root);
    const savepoint = await createMumuMemorySavepoint(root, { id: "sp-root-structured-only" });
    expect(existsSync(path.join(root, "turns"))).toBe(false);

    writeJson(root, storyPath, { id: "s1", title: "Current" });
    writeJson(root, currentOnlyPath, { id: "s2", title: "Current only" });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "story_douyin",
      key: "s2",
      source: "chatter"
    });
    await queue.flush(root);
    const currentHead = git(root, "rev-parse", "HEAD").trim();

    const result = await restoreMumuMemorySavepoint(root, savepoint.id, { scope: { kind: "root" } });

    expect(result.previous_head_sha).toBe(currentHead);
    expect(result.restore_commit_sha).toMatch(/^[a-f0-9]{40}$/u);
    expect(result.restored_paths).toEqual([storyPath]);
    expect(result.deleted_paths).toEqual([currentOnlyPath]);
    expect(JSON.parse(readFileSync(path.join(root, storyPath), "utf8"))).toMatchObject({ title: "Original" });
    expect(existsSync(path.join(root, currentOnlyPath))).toBe(false);
    expect(existsSync(path.join(root, "turns"))).toBe(false);
    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("3");
    expect(git(root, "log", "--oneline", "-1")).toContain("mumu memory restore savepoint sp-root-structured-only");
    expect(git(root, "cat-file", "-t", savepoint.commit_sha).trim()).toBe("commit");
    expect(git(root, "cat-file", "-t", currentHead).trim()).toBe("commit");
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("leaves current content unchanged when restore targets an invalid savepoint", async () => {
    const root = makeRoot();
    const storyPath = "structured/story_douyin/s1.json";
    writeJson(root, storyPath, { id: "s1", title: "Current story" });
    const queue = new MumuMemoryGitSyncQueue({ debounceMs: 0, maxFileBytes: 1024 * 1024 });
    queue.enqueue({
      memoryRoot: root,
      userId: "u1",
      eventKind: "structured_write",
      recordType: "story_douyin",
      key: "s1",
      source: "chatter"
    });
    await queue.flush(root);
    const before = readFileSync(path.join(root, storyPath), "utf8");
    const headBefore = git(root, "rev-parse", "HEAD").trim();

    await expect(restoreMumuMemorySavepoint(root, "sp-missing-savepoint", {
      scope: { kind: "record", record_type: "story_douyin", key: "s1" }
    })).rejects.toMatchObject({ code: "savepoint_not_found" });

    expect(readFileSync(path.join(root, storyPath), "utf8")).toBe(before);
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(headBefore);
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
    expect(snapshotMumuGitPushCounters()).toEqual({ blocked: 1 });
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
