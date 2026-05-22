import { describe, expect, it } from "vitest";
import * as path from "node:path";

import {
  TokenUsageCollector,
  encodeClaudeProjectPath,
  isCodexExecCommand,
  listCodexRolloutFiles,
  parseClaudeUsage,
  parseCodexUsage,
  peekCodexSessionMeta,
  type ProcessAttrs
} from "../token-usage";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CODEX_ROOT = "/fake/.codex/sessions";
const CLAUDE_ROOT = "/fake/.claude/projects";

// One representative codex rollout file. Two `token_count` events: an earlier
// one (cumulative) and a later one (the canonical "last" value the collector
// should pick).
const codexRollout = (
  sessionId: string,
  startIso: string,
  cwd: string,
  lastInput = 18222,
  lastOutput = 625,
  source: "exec" | "cli" | undefined = undefined
): string => [
  JSON.stringify({
    timestamp: startIso,
    type: "session_meta",
    payload: { id: sessionId, cwd, timestamp: startIso, originator: source === "cli" ? "codex-tui" : "codex_exec", ...(source ? { source } : {}) }
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

  it("caches negative resolution with TTL — re-resolves after TTL expires, not on every poll", () => {
    // codex creates the rollout file ~14s after process start (live obs).
    // The first poll can hit BEFORE the file exists, so we must eventually
    // re-resolve — but not on EVERY poll. Negative resolution is expensive
    // (ps + lsof spawn + N×64KB rollout-head reads); without a TTL, every
    // stable orphan PID burns syspolicyd/trustd on every /api/agentapi-processes
    // poll (root-caused 2026-05-21, see learnings/token-usage-orphan-pid-rollout-fanout-storm.md).
    // Contract: a null resolution is cached for NEGATIVE_RESOLUTION_TTL_MS
    // (30s); subsequent lookups within that window return null without
    // re-running ps/lsof/rollout-scan; lookups after the window re-resolve.
    const sessionId = "019e3442-8352-7282-bc7f-31ea41f2a0fa";
    const startIso = "2026-05-17T13:47:14Z";
    const cwd = "/Users/yzliu/work";
    const startMs = Date.parse(startIso) - 14_000; // pid started 14s before session_meta
    const rolloutPath = path.join(
      CODEX_ROOT, "2026", "05", "17",
      `rollout-2026-05-17T13-47-14-${sessionId}.jsonl`
    );

    // Phase 1: rollout file doesn't exist yet. First lookup pays ps+lsof.
    const files = new Map<string, string>();
    let fs = makeFs(files);
    let getCalls = 0;
    let nowMs = startMs;
    const collector = new TokenUsageCollector({
      listDir: (dir: string) => { try { return fs.listDir(dir); } catch { return []; } },
      readFile: (p: string) => fs.readFile(p),
      readHead: (p: string, n: number) => fs.readHead(p, n),
      stat: (p: string) => fs.stat(p),
      getProcessAttrs: () => { getCalls += 1; return { startMs, cwd }; },
      now: () => new Date(nowMs),
      codexSessionsRoot: CODEX_ROOT,
      claudeProjectsRoot: CLAUDE_ROOT
    });
    expect(collector.lookup(99, "codex")).toBeNull();
    expect(getCalls).toBe(1);

    // Phase 1b: second lookup 5s later — served from negative cache, no
    // ps/lsof exec. This is the line that broke the cost model before the TTL.
    nowMs += 5_000;
    expect(collector.lookup(99, "codex")).toBeNull();
    expect(getCalls).toBe(1);

    // Phase 2: rollout file appears and TTL elapses → re-resolve and succeed.
    files.set(rolloutPath, codexRollout(sessionId, startIso, cwd));
    fs = makeFs(files);
    nowMs += 35_000; // 40s total — past the 30s TTL
    const usage = collector.lookup(99, "codex");
    expect(usage?.session_file).toBe(rolloutPath);
    expect(getCalls).toBe(2);
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

  it("interactive codex (no `exec` in argv) skips a stateless source=exec rollout in the same cwd/time window", () => {
    // Live obs 2026-05-17 (agent-dispatcher-00f759ff): codex_01 pid 77365
    // (agentapi-bound, argv `node .../codex --dangerously...`) had no rollout
    // yet (no LLM turn) but a stateless `codex exec --json` rollout existed
    // in the same cwd 16s after its start. Without source filtering, 77365
    // mis-attributed the stateless call's 92.6k totals as its own — every
    // shim in the cwd showed identical tokens.
    const cwd = "/Users/yzliu/work";
    const startMs = Date.parse("2026-05-17T14:47:53Z");
    const execMetaIso = "2026-05-17T14:48:09Z"; // 16s after pid start, in window
    const execPath = path.join(
      CODEX_ROOT, "2026", "05", "17",
      "rollout-2026-05-17T14-48-09-exec.jsonl"
    );
    const files = new Map<string, string>([
      [execPath, codexRollout("exec-sess", execMetaIso, cwd, 92600, 1770, "exec")]
    ]);
    const fs = makeFs(files);
    const collector = new TokenUsageCollector({
      ...fs,
      getProcessAttrs: () => ({ startMs, cwd }),
      codexSessionsRoot: CODEX_ROOT,
      claudeProjectsRoot: CLAUDE_ROOT
    });
    // Interactive argv (NO `exec` subcommand) — must NOT match the exec rollout.
    const interactive = collector.lookup(77365, "codex", "node /Users/y/.local/share/fnm/aliases/default/bin/codex --dangerously-bypass-approvals-and-sandbox");
    expect(interactive).toBeNull();
    // Stateless exec argv in the same cwd/window — SHOULD match.
    const exec = collector.lookup(77539, "codex", "node /Users/y/.local/share/fnm/aliases/default/bin/codex exec --json --dangerously-bypass-approvals-and-sandbox");
    expect(exec?.session_file).toBe(execPath);
    expect(exec?.input_tokens).toBe(92600);
  });

  it("stateless exec codex skips a source=cli rollout in the same cwd/time window", () => {
    // Mirror of the above: when a cli rollout exists but the live process
    // is `codex exec --json`, we must skip the cli rollout.
    const cwd = "/Users/yzliu/work";
    const startMs = Date.parse("2026-05-17T14:50:00Z");
    const cliMetaIso = "2026-05-17T14:50:05Z";
    const cliPath = path.join(
      CODEX_ROOT, "2026", "05", "17",
      "rollout-2026-05-17T14-50-05-cli.jsonl"
    );
    const files = new Map<string, string>([
      [cliPath, codexRollout("cli-sess", cliMetaIso, cwd, 1234, 56, "cli")]
    ]);
    const fs = makeFs(files);
    const collector = new TokenUsageCollector({
      ...fs,
      getProcessAttrs: () => ({ startMs, cwd }),
      codexSessionsRoot: CODEX_ROOT,
      claudeProjectsRoot: CLAUDE_ROOT
    });
    expect(collector.lookup(99, "codex", "node /codex exec --json")).toBeNull();
    expect(collector.lookup(100, "codex", "node /codex --dangerously-bypass-approvals-and-sandbox")?.session_file).toBe(cliPath);
  });

  it("legacy rollouts without a `source` field still resolve (no regression)", () => {
    // Pre-source-field rollouts must continue to match — the filter only
    // kicks in when the rollout's session_meta actually carries `source`.
    const { files, rolloutPath, startMs, cwd } = (() => {
      const sessionId = "legacy";
      const startIso = "2026-05-17T16:00:00Z";
      const cwd = "/Users/yzliu/work";
      const rolloutPath = path.join(CODEX_ROOT, "2026", "05", "17", `rollout-2026-05-17T16-00-00-${sessionId}.jsonl`);
      const files = new Map<string, string>([[rolloutPath, codexRollout(sessionId, startIso, cwd)]]);
      return { files, rolloutPath, startMs: Date.parse(startIso) - 5_000, cwd };
    })();
    const fs = makeFs(files);
    const collector = new TokenUsageCollector({
      ...fs,
      getProcessAttrs: () => ({ startMs, cwd }),
      codexSessionsRoot: CODEX_ROOT,
      claudeProjectsRoot: CLAUDE_ROOT
    });
    expect(collector.lookup(1, "codex", "codex --some-flag")?.session_file).toBe(rolloutPath);
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

  it("resolves a long-running claude session whose mtime drifted far past startMs (birthtime stays near startMs)", () => {
    // Live obs 2026-05-17: 6 claude CLIs in /Users/yzliu/work/projects/clawso-v3-build,
    // most started 23h+ ago and still active. Old code keyed the open-window
    // check off mtime, which an active session pushes forward on every turn:
    // mtime - startMs grew to ~23h, far past the 5-min window, so resolver
    // returned null and only 1 of 6 rows ever showed token totals.
    // New code keys off birthtime (created when session begins), which stays
    // constant — so all 6 resolve correctly.
    const cwd = "/Users/yzliu/work/projects/clawso-v3-build";
    const startMs = Date.parse("2026-05-16T14:00:00Z"); // pid started 23h ago
    const sessionId = "long-running-1234-5678-aaaaaaaaaaaa";
    const projectDir = path.join(CLAUDE_ROOT, encodeClaudeProjectPath(cwd));
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    const files = new Map<string, string>([
      [jsonlPath, claudeJsonl(sessionId, [{ in: 100, out: 50, cacheR: 1000, cacheC: 0 }])]
    ]);
    const baseFs = makeFs(files);
    const fs = {
      ...baseFs,
      stat: (p: string) => {
        const c = files.get(p);
        if (c === undefined) return null;
        return {
          mtimeMs: startMs + 23 * 60 * 60 * 1000, // 23h after start (active)
          birthtimeMs: startMs + 2_000,           // session created 2s after pid start
          size: Buffer.byteLength(c)
        };
      }
    };
    const collector = new TokenUsageCollector({
      ...fs,
      getProcessAttrs: () => ({ startMs, cwd }),
      codexSessionsRoot: CODEX_ROOT,
      claudeProjectsRoot: CLAUDE_ROOT
    });
    const usage = collector.lookup(15261, "claude");
    expect(usage?.session_file).toBe(jsonlPath);
    expect(usage?.input_tokens).toBe(100);
  });

  it("picks the claude jsonl with closest birthtime when multiple sessions share a cwd", () => {
    // Multiple concurrent claude CLIs in the same project dir. Each creates
    // its own session jsonl. Active sessions all have mtime ≈ now; only
    // birthtime distinguishes them.
    const cwd = "/Users/yzliu/work/projects/clawso-v3-build";
    const startMs = Date.parse("2026-05-17T13:50:00Z");
    const projectDir = path.join(CLAUDE_ROOT, encodeClaudeProjectPath(cwd));
    const nearPath = path.join(projectDir, "near.jsonl");
    const farPath = path.join(projectDir, "far.jsonl");
    const files = new Map<string, string>([
      [nearPath, claudeJsonl("near", [{ in: 1, out: 1 }])],
      [farPath, claudeJsonl("far", [{ in: 999, out: 999 }])]
    ]);
    const baseFs = makeFs(files);
    const fs = {
      ...baseFs,
      stat: (p: string) => {
        const c = files.get(p);
        if (c === undefined) return null;
        const nowMs = startMs + 60 * 60 * 1000; // both files actively written
        if (p === nearPath) {
          return { mtimeMs: nowMs, birthtimeMs: startMs + 1_000, size: Buffer.byteLength(c) };
        }
        return { mtimeMs: nowMs, birthtimeMs: startMs + 2 * 60 * 1000, size: Buffer.byteLength(c) };
      }
    };
    const collector = new TokenUsageCollector({
      ...fs,
      getProcessAttrs: () => ({ startMs, cwd }),
      codexSessionsRoot: CODEX_ROOT,
      claudeProjectsRoot: CLAUDE_ROOT
    });
    expect(collector.lookup(1, "claude")?.session_file).toBe(nearPath);
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

describe("isCodexExecCommand", () => {
  it("matches `codex exec --json` invocations and the node-shim variant", () => {
    expect(isCodexExecCommand("codex exec --json")).toBe(true);
    expect(isCodexExecCommand("node /Users/y/.local/share/fnm/aliases/default/bin/codex exec --json -c x=y")).toBe(true);
    expect(isCodexExecCommand("/path/codex exec")).toBe(true);
  });
  it("returns false for interactive / agentapi-bound codex", () => {
    expect(isCodexExecCommand("codex --dangerously-bypass-approvals-and-sandbox")).toBe(false);
    expect(isCodexExecCommand("node /path/codex --dangerously-bypass-approvals-and-sandbox")).toBe(false);
    expect(isCodexExecCommand("agentapi server --type=codex -- codex")).toBe(false);
  });
});

describe("peekCodexSessionMeta — source field", () => {
  it("returns source='exec' when present in payload", () => {
    const head = Buffer.from(JSON.stringify({
      type: "session_meta",
      payload: { id: "x", cwd: "/x", timestamp: "2026-05-17T00:00:00Z", source: "exec" }
    }) + "\n");
    expect(peekCodexSessionMeta("/p", () => head)?.source).toBe("exec");
  });
  it("returns source='cli' when present in payload", () => {
    const head = Buffer.from(JSON.stringify({
      type: "session_meta",
      payload: { id: "x", cwd: "/x", timestamp: "2026-05-17T00:00:00Z", source: "cli" }
    }) + "\n");
    expect(peekCodexSessionMeta("/p", () => head)?.source).toBe("cli");
  });
  it("returns source=null for legacy rollouts without the field", () => {
    const head = Buffer.from(JSON.stringify({
      type: "session_meta",
      payload: { id: "x", cwd: "/x", timestamp: "2026-05-17T00:00:00Z" }
    }) + "\n");
    expect(peekCodexSessionMeta("/p", () => head)?.source).toBeNull();
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

  it("prunes rollouts whose filename timestamp is before pid_start - 1s", () => {
    // Filename-window prune: out-of-window candidates are dropped without
    // opening the file. Mirrors the meta-timestamp check inside
    // resolveCodexSessionFile so callers don't pay open()+readSync(64KB) per
    // out-of-window rollout per poll.
    const startMs = Date.parse("2026-05-17T15:00:00Z");
    const files = new Map<string, string>([
      // Earlier on the same day, far outside the [-1s, +5min] window.
      [path.join(CODEX_ROOT, "2026", "05", "17", "rollout-2026-05-17T01-00-00-old.jsonl"), "x"],
      // 30s after pid start — inside the window.
      [path.join(CODEX_ROOT, "2026", "05", "17", "rollout-2026-05-17T15-00-30-current.jsonl"), "y"]
    ]);
    const fs = makeFs(files);
    const found = listCodexRolloutFiles(CODEX_ROOT, startMs, fs.listDir);
    expect(found).toEqual([
      path.join(CODEX_ROOT, "2026", "05", "17", "rollout-2026-05-17T15-00-30-current.jsonl")
    ]);
  });

  it("prunes rollouts whose filename timestamp is past pid_start + 5min", () => {
    const startMs = Date.parse("2026-05-17T15:00:00Z");
    const files = new Map<string, string>([
      // 1min after pid start — inside window.
      [path.join(CODEX_ROOT, "2026", "05", "17", "rollout-2026-05-17T15-01-00-in-window.jsonl"), "x"],
      // 5h after pid start — outside window.
      [path.join(CODEX_ROOT, "2026", "05", "17", "rollout-2026-05-17T20-00-00-future.jsonl"), "y"]
    ]);
    const fs = makeFs(files);
    const found = listCodexRolloutFiles(CODEX_ROOT, startMs, fs.listDir);
    expect(found).toEqual([
      path.join(CODEX_ROOT, "2026", "05", "17", "rollout-2026-05-17T15-01-00-in-window.jsonl")
    ]);
  });

  it("keeps rollout filenames written in local wall time when local offset differs from UTC", () => {
    // Live obs 2026-05-23: codex_10 started at 2026-05-22T20:29:15Z, while
    // Codex wrote rollout-2026-05-23T05-29-15-*.jsonl on a JST host. The
    // filename is local wall time, so treating it as UTC puts it 9h in the
    // future and prunes the real session before session_meta can be checked.
    const startMs = Date.parse("2026-05-22T20:29:15Z");
    const localWallTimePath = path.join(
      CODEX_ROOT, "2026", "05", "23",
      "rollout-2026-05-23T05-29-15-local.jsonl"
    );
    const unrelatedPath = path.join(
      CODEX_ROOT, "2026", "05", "23",
      "rollout-2026-05-23T12-00-00-future.jsonl"
    );
    const files = new Map<string, string>([
      [localWallTimePath, "x"],
      [unrelatedPath, "y"]
    ]);
    const fs = makeFs(files);
    const found = listCodexRolloutFiles(CODEX_ROOT, startMs, fs.listDir, {
      localTimezoneOffsetMinutes: -9 * 60
    });
    expect(found).toEqual([localWallTimePath]);
  });

  it("passes through filenames that don't match the rollout-<ISO>-<uuid> pattern (back-compat)", () => {
    // External fixtures and legacy filenames without an encoded timestamp
    // must reach peekCodexSessionMeta — the filename prune is a fast-path,
    // not an authoritative filter. peek does the canonical window check
    // against session_meta.payload.timestamp.
    const startMs = Date.parse("2026-05-17T15:00:00Z");
    const files = new Map<string, string>([
      [path.join(CODEX_ROOT, "2026", "05", "17", "rollout-A.jsonl"), "x"]
    ]);
    const fs = makeFs(files);
    expect(listCodexRolloutFiles(CODEX_ROOT, startMs, fs.listDir)).toEqual([
      path.join(CODEX_ROOT, "2026", "05", "17", "rollout-A.jsonl")
    ]);
  });

  it("at scale: 89 rollouts in a day directory, only the in-window ones survive prune (no file I/O)", () => {
    // Live observed 2026-05-21: 89 rollouts in ~/.codex/sessions/2026/05/21/.
    // Pre-fix, every unresolved-PID poll opened+read64KB from all 89. Post-fix,
    // only candidates whose filename timestamp falls inside the open window
    // are returned — listDir is the only I/O the function performs.
    const dayDir = path.join(CODEX_ROOT, "2026", "05", "17");
    const fakeFiles = new Map<string, string>();
    // 87 out-of-window rollouts spread across the same UTC day. Skip the
    // 15:00 hour so no fixture collides with pid_start's [-1s, +5min] window.
    for (let h = 0; h < 24 && fakeFiles.size < 87; h += 1) {
      if (h === 15) continue;
      for (let i = 0; i < 4 && fakeFiles.size < 87; i += 1) {
        const hh = String(h).padStart(2, "0");
        const mm = String(i * 13).padStart(2, "0");
        fakeFiles.set(
          path.join(dayDir, `rollout-2026-05-17T${hh}-${mm}-00-old-${h}-${i}.jsonl`),
          "x"
        );
      }
    }
    // 2 in-window rollouts.
    fakeFiles.set(path.join(dayDir, "rollout-2026-05-17T15-00-30-near.jsonl"), "y");
    fakeFiles.set(path.join(dayDir, "rollout-2026-05-17T15-02-15-nearer.jsonl"), "z");

    let listDirCalls = 0;
    const fs = makeFs(fakeFiles);
    const trackedListDir = (dir: string): string[] => {
      listDirCalls += 1;
      return fs.listDir(dir);
    };

    const startMs = Date.parse("2026-05-17T15:00:00Z");
    const found = listCodexRolloutFiles(CODEX_ROOT, startMs, trackedListDir);

    // Only the two in-window rollouts survived; listDir was called exactly
    // twice (one for the start day, one for the next day — the next day's
    // dir doesn't exist so listDir throws and is caught).
    expect(found.sort()).toEqual([
      path.join(dayDir, "rollout-2026-05-17T15-00-30-near.jsonl"),
      path.join(dayDir, "rollout-2026-05-17T15-02-15-nearer.jsonl")
    ]);
    expect(listDirCalls).toBe(2);
  });
});
