import { describe, expect, it } from "vitest";
import * as path from "node:path";

import {
  TokenUsageCollector,
  encodeClaudeProjectPath,
  listCodexRolloutFiles,
  parseClaudeUsage,
  parseCodexUsage,
  type ProcessAttrs
} from "../token-usage";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CODEX_ROOT = "/fake/.codex/sessions";
const CLAUDE_ROOT = "/fake/.claude/projects";

// One representative codex rollout file. Two `token_count` events: an earlier
// one (cumulative) and a later one (the canonical "last" value the collector
// should pick).
const codexRollout = (sessionId: string, startIso: string, cwd: string, lastInput = 18222, lastOutput = 625): string => [
  JSON.stringify({
    timestamp: startIso,
    type: "session_meta",
    payload: { id: sessionId, cwd, timestamp: startIso, originator: "codex_exec" }
  }),
  // a stray non-usage event in between
  JSON.stringify({
    timestamp: startIso,
    type: "event_msg",
    payload: { type: "task_started", turn_id: "t1", started_at: 0 }
  }),
  JSON.stringify({
    timestamp: startIso,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 10,
          output_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 125
        }
      }
    }
  }),
  JSON.stringify({
    timestamp: startIso,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: lastInput,
          cached_input_tokens: 7552,
          output_tokens: lastOutput,
          reasoning_output_tokens: 511,
          total_tokens: lastInput + lastOutput
        }
      }
    }
  }),
  ""
].join("\n");

const claudeJsonl = (sessionId: string, turns: Array<{ in: number; out: number; cacheR?: number; cacheC?: number }>): string => [
  // System line without usage — should be ignored.
  JSON.stringify({ sessionId, type: "summary", summary: "x" }),
  ...turns.map((t) => JSON.stringify({
    sessionId,
    type: "assistant",
    message: {
      usage: {
        input_tokens: t.in,
        output_tokens: t.out,
        cache_read_input_tokens: t.cacheR ?? 0,
        cache_creation_input_tokens: t.cacheC ?? 0
      }
    }
  })),
  ""
].join("\n");

// ─── Pure-function tests ────────────────────────────────────────────────────

describe("encodeClaudeProjectPath", () => {
  it("turns / into -", () => {
    expect(encodeClaudeProjectPath("/Users/yzliu/work/Meridian/Meridian-roles"))
      .toBe("-Users-yzliu-work-Meridian-Meridian-roles");
  });
});

describe("parseCodexUsage", () => {
  it("picks the LAST token_count event's cumulative totals", () => {
    const buf = Buffer.from(codexRollout("019e3390-b9ef-70e2-a48c-96bb38c62574", "2026-05-17T01:33:14Z", "/Users/foo/work"));
    const usage = parseCodexUsage(buf, "/path/to/rollout.jsonl");
    expect(usage).not.toBeNull();
    expect(usage?.source).toBe("codex");
    expect(usage?.input_tokens).toBe(18222);
    expect(usage?.output_tokens).toBe(625);
    expect(usage?.cached_input_tokens).toBe(7552);
    expect(usage?.reasoning_output_tokens).toBe(511);
    expect(usage?.total_tokens).toBe(18222 + 625);
    expect(usage?.session_id).toBe("019e3390-b9ef-70e2-a48c-96bb38c62574");
    expect(usage?.session_file).toBe("/path/to/rollout.jsonl");
  });

  it("returns null when no token_count events are present", () => {
    const onlyMeta = JSON.stringify({
      type: "session_meta",
      payload: { id: "x", cwd: "/foo", timestamp: "2026-05-17T00:00:00Z" }
    }) + "\n";
    expect(parseCodexUsage(Buffer.from(onlyMeta), "/x")).toBeNull();
  });

  it("ignores malformed lines and recovers", () => {
    const buf = Buffer.from([
      "{this is not json",
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 50,
              output_tokens: 5,
              cached_input_tokens: 0,
              reasoning_output_tokens: 0,
              total_tokens: 55
            }
          }
        }
      })
    ].join("\n"));
    expect(parseCodexUsage(buf, "/x")?.input_tokens).toBe(50);
  });
});

describe("parseClaudeUsage", () => {
  it("sums per-turn usage and surfaces session_id", () => {
    const buf = Buffer.from(claudeJsonl("sess-1", [
      { in: 10, out: 5, cacheR: 100, cacheC: 1000 },
      { in: 20, out: 7, cacheR: 200, cacheC: 0 }
    ]));
    const usage = parseClaudeUsage(buf, "/path/sess-1.jsonl");
    expect(usage?.source).toBe("claude");
    expect(usage?.input_tokens).toBe(30);
    expect(usage?.output_tokens).toBe(12);
    expect(usage?.cached_input_tokens).toBe(300);          // cache_read mapped here
    expect(usage?.total_tokens).toBe(30 + 12 + 300 + 1000); // includes cache_creation
    expect(usage?.session_id).toBe("sess-1");
  });

  it("returns null when no usage blocks are present", () => {
    const buf = Buffer.from(JSON.stringify({ sessionId: "s", type: "summary" }) + "\n");
    expect(parseClaudeUsage(buf, "/x")).toBeNull();
  });
});

// ─── Collector integration (with injected IO) ───────────────────────────────

function makeFs(files: Map<string, string>): {
  listDir: (dir: string) => string[];
  readFile: (p: string) => Buffer;
  readHead: (p: string, length: number) => Buffer;
  stat: (p: string) => { mtimeMs: number; size: number } | null;
} {
  const readFile = (p: string) => {
    const content = files.get(p);
    if (content === undefined) throw new Error("ENOENT: " + p);
    return Buffer.from(content);
  };
  return {
    listDir: (dir: string) => {
      const dirs = new Set<string>();
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      for (const p of files.keys()) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          const slash = rest.indexOf("/");
          dirs.add(slash >= 0 ? rest.slice(0, slash) : rest);
        }
      }
      if (dirs.size === 0) throw new Error("ENOENT: " + dir);
      return [...dirs];
    },
    readFile,
    readHead: (p, length) => readFile(p).subarray(0, length),
    stat: (p: string) => {
      const content = files.get(p);
      if (content === undefined) return null;
      return { mtimeMs: 1_000_000, size: Buffer.byteLength(content) };
    }
  };
}

describe("TokenUsageCollector — codex", () => {
  function setup() {
    const sessionId = "019e3390-b9ef-70e2-a48c-96bb38c62574";
    const startIso = "2026-05-17T10:33:14Z";
    const cwd = "/Users/yzliu/work";
    const rolloutPath = path.join(
      CODEX_ROOT, "2026", "05", "17",
      `rollout-2026-05-17T10-33-14-${sessionId}.jsonl`
    );
    const files = new Map<string, string>([
      [rolloutPath, codexRollout(sessionId, startIso, cwd)]
    ]);
    return { files, rolloutPath, startMs: Date.parse(startIso) - 10_000 /* pid started 10s before session_meta */, cwd };
  }

  it("resolves a live codex pid to its rollout file and surfaces tokens", () => {
    const { files, rolloutPath, startMs, cwd } = setup();
    const fs = makeFs(files);
    const collector = new TokenUsageCollector({
      ...fs,
      getProcessAttrs: (pid) => pid === 12345 ? ({ startMs, cwd } as ProcessAttrs) : null,
      codexSessionsRoot: CODEX_ROOT,
      claudeProjectsRoot: CLAUDE_ROOT
    });
    const usage = collector.lookup(12345, "codex");
    expect(usage?.session_file).toBe(rolloutPath);
    expect(usage?.input_tokens).toBe(18222);
  });

  it("returns null when cwd doesn't match any rollout", () => {
    const { files, startMs } = setup();
    const fs = makeFs(files);
    const collector = new TokenUsageCollector({
      ...fs,
      getProcessAttrs: () => ({ startMs, cwd: "/somewhere/else" }),
      codexSessionsRoot: CODEX_ROOT,
      claudeProjectsRoot: CLAUDE_ROOT
    });
    expect(collector.lookup(999, "codex")).toBeNull();
  });

  it("returns null when pid start time is much later than any session", () => {
    const { files, cwd } = setup();
    const fs = makeFs(files);
    const collector = new TokenUsageCollector({
      ...fs,
      // pid started a week after the session file's session_meta.timestamp
      getProcessAttrs: () => ({ startMs: Date.parse("2026-05-24T00:00:00Z"), cwd }),
      codexSessionsRoot: CODEX_ROOT,
      claudeProjectsRoot: CLAUDE_ROOT
    });
    expect(collector.lookup(999, "codex")).toBeNull();
  });

  it("paired shim+native pids resolve to the same session file (same cwd + similar start)", () => {
    const { files, rolloutPath, startMs, cwd } = setup();
    const fs = makeFs(files);
    const collector = new TokenUsageCollector({
      ...fs,
      // Shim and native both have the inherited cwd and near-identical start.
      getProcessAttrs: (pid) => pid === 1 || pid === 2 ? ({ startMs, cwd } as ProcessAttrs) : null,
      codexSessionsRoot: CODEX_ROOT,
      claudeProjectsRoot: CLAUDE_ROOT
    });
    const shim = collector.lookup(1, "codex");
    const native = collector.lookup(2, "codex");
    expect(shim?.session_file).toBe(rolloutPath);
    expect(native?.session_file).toBe(rolloutPath);
    expect(shim?.total_tokens).toBe(native?.total_tokens);
  });

  it("caches POSITIVE per-pid resolution; retain() drops dead pids", () => {
    const { files, startMs, cwd } = setup();
    const fs = makeFs(files);
    let getCalls = 0;
    const collector = new TokenUsageCollector({
      ...fs,
      getProcessAttrs: () => { getCalls += 1; return { startMs, cwd }; },
      codexSessionsRoot: CODEX_ROOT,
      claudeProjectsRoot: CLAUDE_ROOT
    });
    collector.lookup(100, "codex");
    collector.lookup(100, "codex");
    expect(getCalls).toBe(1);
    collector.retain(new Set([])); // pid 100 is gone
    collector.lookup(100, "codex");
    expect(getCalls).toBe(2);
  });

  it("does NOT cache negative resolution — retries when rollout file appears later", () => {
    // codex creates the rollout file ~14s after process start (live obs).
    // The first poll can hit BEFORE the file exists; we must re-resolve on
    // subsequent polls instead of permanently caching null. Otherwise every
    // codex session whose first poll preceded the rollout — and every short
    // stateless validator — would silently have no tokens forever.
    const sessionId = "019e3442-8352-7282-bc7f-31ea41f2a0fa";
    const startIso = "2026-05-17T13:47:14Z";
    const cwd = "/Users/yzliu/work";
    const startMs = Date.parse(startIso) - 14_000; // pid started 14s before session_meta
    const rolloutPath = path.join(
      CODEX_ROOT, "2026", "05", "17",
      `rollout-2026-05-17T13-47-14-${sessionId}.jsonl`
    );

    // Phase 1: rollout file doesn't exist yet.
    const files = new Map<string, string>();
    let fs = makeFs(files);
    let getCalls = 0;
    const collector = new TokenUsageCollector({
      listDir: (dir: string) => { try { return fs.listDir(dir); } catch { return []; } },
      readFile: (p: string) => fs.readFile(p),
      readHead: (p: string, n: number) => fs.readHead(p, n),
      stat: (p: string) => fs.stat(p),
      getProcessAttrs: () => { getCalls += 1; return { startMs, cwd }; },
      codexSessionsRoot: CODEX_ROOT,
      claudeProjectsRoot: CLAUDE_ROOT
    });
    expect(collector.lookup(99, "codex")).toBeNull();
    expect(getCalls).toBe(1);

    // Phase 2: rollout file appears. Same PID, should re-resolve and succeed.
    files.set(rolloutPath, codexRollout(sessionId, startIso, cwd));
    fs = makeFs(files);
    const usage = collector.lookup(99, "codex");
    expect(usage?.session_file).toBe(rolloutPath);
    expect(getCalls).toBe(2); // re-resolved, not served from negative cache
  });

  it("picks the CLOSEST start-time match when multiple rollouts share cwd in-window", () => {
    // Concurrent codex sessions in the same cwd (Meridian hub forks all codex
    // from `/Users/yzliu/work`): the resolver must pick the rollout whose
    // session_meta.timestamp is closest to the pid's start, not just the
    // first one in readdir order.
    const cwd = "/Users/yzliu/work";
    const pidStartIso = "2026-05-17T13:50:00Z";
    const farSessionIso = "2026-05-17T13:47:14Z"; // 2m46s before pid start — rejected: before pid_start - 1s
    const nearSessionIso = "2026-05-17T13:50:08Z"; // 8s after pid start — kept
    const farPath = path.join(
      CODEX_ROOT, "2026", "05", "17",
      "rollout-2026-05-17T13-47-14-far.jsonl"
    );
    const nearPath = path.join(
      CODEX_ROOT, "2026", "05", "17",
      "rollout-2026-05-17T13-50-08-near.jsonl"
    );
    const files = new Map<string, string>([
      [farPath, codexRollout("far", farSessionIso, cwd)],
      [nearPath, codexRollout("near", nearSessionIso, cwd)]
    ]);
    const fs = makeFs(files);
    const collector = new TokenUsageCollector({
      ...fs,
      getProcessAttrs: () => ({ startMs: Date.parse(pidStartIso), cwd }),
      codexSessionsRoot: CODEX_ROOT,
      claudeProjectsRoot: CLAUDE_ROOT
    });
    expect(collector.lookup(1, "codex")?.session_file).toBe(nearPath);
  });

  it("closest-match still applies when both candidates are after pid_start", () => {
    // Stricter version of the previous test: both candidates inside the
    // window, but one is closer than the other.
    const cwd = "/Users/yzliu/work";
    const pidStartIso = "2026-05-17T13:50:00Z";
    const closeIso = "2026-05-17T13:50:05Z"; // +5s
    const farIso = "2026-05-17T13:53:00Z";   // +3min, still in 5-min window
    const closePath = path.join(
      CODEX_ROOT, "2026", "05", "17",
      "rollout-2026-05-17T13-50-05-close.jsonl"
    );
    const farPath = path.join(
      CODEX_ROOT, "2026", "05", "17",
      "rollout-2026-05-17T13-53-00-far.jsonl"
    );
    const files = new Map<string, string>([
      [farPath, codexRollout("far", farIso, cwd)],
      [closePath, codexRollout("close", closeIso, cwd)]
    ]);
    const fs = makeFs(files);
    const collector = new TokenUsageCollector({
      ...fs,
      getProcessAttrs: () => ({ startMs: Date.parse(pidStartIso), cwd }),
      codexSessionsRoot: CODEX_ROOT,
      claudeProjectsRoot: CLAUDE_ROOT
    });
    expect(collector.lookup(1, "codex")?.session_file).toBe(closePath);
  });
});

describe("TokenUsageCollector — claude", () => {
  it("resolves a live claude pid to its project jsonl and sums usage", () => {
    const cwd = "/Users/yzliu/work/Meridian/Meridian-roles";
    const startMs = Date.parse("2026-05-17T10:00:00Z");
    const sessionId = "29419cbb-4356-45c1-9c07-8711617e00d1";
    const projectDir = path.join(CLAUDE_ROOT, encodeClaudeProjectPath(cwd));
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    const files = new Map<string, string>([
      [jsonlPath, claudeJsonl(sessionId, [
        { in: 1, out: 100, cacheR: 5000, cacheC: 0 },
        { in: 2, out: 200, cacheR: 6000, cacheC: 100 }
      ])]
    ]);
    // Override stat to put mtime ≥ startMs so the heuristic picks the file.
    const baseFs = makeFs(files);
    const fs = {
      ...baseFs,
      stat: (p: string) => {
        const c = files.get(p);
        if (c === undefined) return null;
        return { mtimeMs: startMs + 5_000, size: Buffer.byteLength(c) };
      }
    };
    const collector = new TokenUsageCollector({
      ...fs,
      getProcessAttrs: () => ({ startMs, cwd }),
      codexSessionsRoot: CODEX_ROOT,
      claudeProjectsRoot: CLAUDE_ROOT
    });
    const usage = collector.lookup(77, "claude");
    expect(usage?.session_file).toBe(jsonlPath);
    expect(usage?.input_tokens).toBe(3);
    expect(usage?.output_tokens).toBe(300);
    expect(usage?.cached_input_tokens).toBe(11_000);
  });

  it("returns null when the project directory has no jsonl", () => {
    const cwd = "/Users/yzliu/work/nothing-here";
    const startMs = Date.now();
    const collector = new TokenUsageCollector({
      listDir: () => { throw new Error("ENOENT"); },
      readFile: () => Buffer.from(""),
      readHead: () => Buffer.from(""),
      stat: () => null,
      getProcessAttrs: () => ({ startMs, cwd }),
      codexSessionsRoot: CODEX_ROOT,
      claudeProjectsRoot: CLAUDE_ROOT
    });
    expect(collector.lookup(1, "claude")).toBeNull();
  });
});

describe("listCodexRolloutFiles", () => {
  it("scans both the start day and the next day (UTC midnight crossing)", () => {
    const files = new Map<string, string>([
      [path.join(CODEX_ROOT, "2026", "05", "17", "rollout-A.jsonl"), "x"],
      [path.join(CODEX_ROOT, "2026", "05", "18", "rollout-B.jsonl"), "y"],
      [path.join(CODEX_ROOT, "2026", "05", "17", "not-a-rollout.txt"), "z"]
    ]);
    const fs = makeFs(files);
    // Start near end of May 17 UTC; expect both A and B in the scan.
    const startMs = Date.parse("2026-05-17T23:50:00Z");
    const found = listCodexRolloutFiles(CODEX_ROOT, startMs, fs.listDir);
    expect(found.sort()).toEqual([
      path.join(CODEX_ROOT, "2026", "05", "17", "rollout-A.jsonl"),
      path.join(CODEX_ROOT, "2026", "05", "18", "rollout-B.jsonl")
    ]);
  });
});
