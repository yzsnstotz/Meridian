import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { promisify } = await vi.importActual<typeof import("node:util")>("node:util");
  const execFile = (file: string, args: readonly string[], options: unknown, callback: unknown) => {
    const done = callback as (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;
    if (file === "git" && Array.isArray(args) && args.includes("push")) {
      const stderr = [
        "To https://github.com/yzsnstotz/mumu-archive-u1.git",
        " ! [rejected]        main -> main (non-fast-forward)",
        "error: failed to push some refs to 'https://github.com/yzsnstotz/mumu-archive-u1.git'"
      ].join("\n");
      const error = Object.assign(new Error("Command failed: git push"), { stdout: "", stderr });
      done(error, "", stderr);
      return {};
    }
    return (actual.execFile as unknown as (
      command: string,
      commandArgs: readonly string[],
      commandOptions: unknown,
      commandCallback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void
    ) => unknown)(file, args, options, done);
  };
  Object.defineProperty(execFile, promisify.custom, {
    value: (file: string, args: readonly string[], options: unknown) =>
      new Promise((resolve, reject) => {
        execFile(file, args, options, (
          error: (NodeJS.ErrnoException & { stdout?: string; stderr?: string }) | null,
          stdout: string,
          stderr: string
        ) => {
          if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        });
      })
  });
  return {
    ...actual,
    execFile
  };
});

import { MumuMemoryGitSyncQueue } from "../mumu-memory-git-sync";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("MumuMemoryGitSyncQueue default git push classification", () => {
  it("classifies non-fast-forward stderr from the default git push path as conflict_pending", async () => {
    const root = makeRoot();
    writeJson(root, "structured/story_short_drama/s1.json", { id: "s1", title: "Story" });
    const queue = new MumuMemoryGitSyncQueue({
      debounceMs: 0,
      maxFileBytes: 1024 * 1024,
      pushRetryDelaysMs: [],
      serviceGithubToken: "service-token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ name: "mumu-archive-u1", full_name: "yzsnstotz/mumu-archive-u1", private: true }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    });

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
    });

    const result = await queue.flush(root);

    expect(result?.remote).toMatchObject({ status: "conflict_pending", lastErrorClass: "conflict_pending" });
    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("1");
  });
});

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mumu-memory-git-sync-default-push-"));
  roots.push(root);
  return root;
}

function writeJson(root: string, relativePath: string, value: unknown): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
