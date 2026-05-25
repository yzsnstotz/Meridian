import { execFileSync } from "node:child_process";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { LifecycleStore } from "../roles/agent-dispatcher/lifecycle-store";
import type { Logger } from "../roles/base-role";
import type { StateStore } from "../state-store";
import { TokenUsageCollector, extractCodexResumeSessionId, type TokenUsage } from "./token-usage";
import { AgentDispatcherConfigSchema, type AgentInstance, type DispatchThreadStateV2, type AppState } from "../types";

export interface ProcessHandlersOptions {
  stateStore: Pick<StateStore, "load">;
  log?: Logger;
  // Test seam — defaults to `ps -A -o pid,ppid,etime,command`.
  listProcesses?: () => ProcInfo[];
  // Optional: full Hub instance registry. Streaming bridge instances are
  // registered as pid/socket_path null while idle between turns, so this is
  // the only source that can keep those alive threads visible in the Processes
  // tab when no OS child is currently running.
  fetchAgentapiInstances?: () => Promise<AgentInstance[]>;
  // Optional: when Meridian Hub spawns agentapi via TCP port (the host kernel
  // doesn't support --socket), the agentapi argv has no /tmp/agentapi-<id>.sock
  // marker. Hub-direct `codex exec` validator/PM calls also have no agentapi
  // parent at all. The handler calls this once per request to fetch the Hub's
  // instance registry, then looks up `pid → thread_id` from it. If the call
  // throws or returns nothing, attribution falls back to socket-path parsing
  // only and unbound managed processes will be flagged as leaks.
  fetchAgentapiInstanceIndex?: () => Promise<Map<number, string>>;
  // Optional: attaches cumulative LLM token totals to each codex/claude
  // snapshot entry by resolving the process to its on-disk session file.
  // When omitted, a default TokenUsageCollector is constructed; pass `null`
  // explicitly (via createProcessHandlers({ tokenUsageCollector: null }))
  // to disable enrichment entirely (e.g. tests that don't care).
  tokenUsageCollector?: TokenUsageCollector | null;
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  etime: string;
  command: string;
}

// Origin of an agent-shaped process from meridian-roles' point of view:
//   "managed":  meridian-roles spawned this (either an `agentapi server` or a
//               codex/claude CLI whose PPID chain leads to an agentapi parent
//               we can see)
//   "hub":      Meridian Hub reports this as a live thread, but this
//               meridian-roles service has no dispatcher lifecycle binding for
//               it. It may belong to another caller (ADS) or to a roles
//               dispatcher no longer registered in local state.
//   "external": agent-shaped process the user is running themselves
//               (terminal `codex`, interactive `claude`, Claude Code session,
//               other tools). NOT a leak — just noise the operator can
//               recognize at a glance.
//   "orphan":   meridian-roles AGENTAPI is gone but its codex/claude child
//               survived (the documented active-tool-process.ts:39 pattern).
//               Treated as a leak because operator needs to clean these up.
export type ProcessOrigin = "managed" | "hub" | "external" | "orphan";

export interface ProcessSnapshotEntry {
  pid: number | null;
  ppid: number | null;
  etime: string;
  agent_type: "agentapi" | AgentInstance["agent_type"] | null;
  thread_id: string | null;
  origin: ProcessOrigin;
  binding: BindingSnapshot | null;
  is_leak: boolean;
  command: string;
  token_usage: TokenUsage | null;
}

export interface BindingSnapshot {
  dispatcher_role_id: string;
  worker_id: string;
  role: "dispatcher" | "worker" | "pm_resolver" | "validator";
  status: string;
  started_at: string | null;
}

export interface ProcessHandlers {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

// argv markers
const AGENTAPI_SOCKET_PATTERN = /\/agentapi-([^/\s]+?)\.sock/;
const AGENTAPI_PORT_PATTERN = /--port=(\d+)/;
// `agentapi server` parent (real or symlinked binary path)
const AGENTAPI_COMMAND_PATTERN = /(?:^|[\s/])agentapi\s+server(?:\s|$)/;
// `codex exec ... --json` — the canonical Hub-direct streaming argv shape
// used by bridge turns and stateless validator/PM calls. This includes both
// first turns (`codex exec --json`) and resumed threads
// (`codex exec resume <session> --json`). The `--json` flag disambiguates it
// from a user-launched interactive `codex exec`.
const CODEX_EXEC_JSON_PATTERN = /(?:^|[\s/])codex\s+exec(?:\s|$)(?=.*--json(?:\s|$))/;
// Codex CLI — bare `codex `, native binary path `.../codex/codex` or `.../codex`,
// or node-wrapped `node .../codex`. Matches the executable name after start, a
// path separator, or whitespace.
const CODEX_COMMAND_PATTERN = /(?:^|[\s/])codex(?:\s|$)/;
// Claude CLI — `claude --flag` or path-prefixed `.../claude --flag`.
const CLAUDE_COMMAND_PATTERN = /(?:^|[\s/])claude(?:\s|$)/;

// Worker lifecycle statuses where the codex worker thread is intentionally
// kept alive (mirrors tool-gateway/tools/run.ts:335 cleanupWorkerThread). Any
// row in this set with a non-empty thread_id is a legitimate binding for the
// Processes tab — NOT a leak.
const LIVE_WORKER_STATUSES = new Set<string>([
  "running",
  "awaiting_validation",
  "fix_requested",
  "blocked"
]);
const LIVE_HUB_INSTANCE_STATUSES = new Set<AgentInstance["status"]>([
  "idle",
  "running",
  "waiting"
]);
const DISPATCHER_WORKER_ID = "DISPATCHER";

function isLiveWorkerStatus(status: string | undefined | null): boolean {
  return status !== undefined && status !== null && LIVE_WORKER_STATUSES.has(status);
}

// Meridian hub PM2 process names. codex/claude spawned BY the Meridian hub
// itself (calling-hub spawns codex for short-lived notification / scheduler
// turns) are NOT meridian-roles' responsibility — without this exclusion they
// look like orphans because they have meridian-roles spawn markers
// (--dangerously-bypass-approvals-and-sandbox) but live under the hub
// process tree.
const MERIDIAN_HUB_PROCESS_PATTERN = /(?:^|[\s/])(?:calling-hub|calling-interface|calling-monitor|calling-web)(?:\s|$|\b)/;
// `node .../hub/index.js` etc — PM2 spawns these as `PM2 calling-hub` but the
// actual node invocation shows `node /Users/.../Meridian/dist/hub/index.js`.
const MERIDIAN_HUB_NODE_PATTERN = /\/Meridian\/(?:dist|src)\/(?:hub|interface|monitor|web)\//;
// Hub launched from its own cwd shows up in `ps` with a RELATIVE script path,
// e.g. `node dist/hub/index.js` or `tsx src/hub/index.ts`. Without this pattern,
// codex/claude that the hub spawns directly (e.g. `codex exec --json` for a
// stateless validator turn) are misclassified as `orphan` because
// `findMeridianHubAncestor` doesn't recognise the hub parent. Observed live
// 2026-05-17 on agent-dispatcher-67f6a3fc.
const MERIDIAN_HUB_RELATIVE_NODE_PATTERN = /(?:^|\s)(?:node|tsx|ts-node)\s+(?:dist|src)\/(?:hub|interface|monitor|web)\/index\.(?:js|ts|mjs|cjs)(?:\s|$)/;

export function createProcessHandlers(options: ProcessHandlersOptions): ProcessHandlers {
  const log = options.log ?? console;
  const listProcesses = options.listProcesses ?? defaultListProcesses;
  // Explicit `null` disables enrichment; `undefined` falls back to the default
  // collector (live ps + fs). Tests pass null when they don't want to mock the
  // file system; the GUI/server path lets the default fire.
  const tokenUsageCollector: TokenUsageCollector | null =
    options.tokenUsageCollector === undefined ? new TokenUsageCollector() : options.tokenUsageCollector;

  async function buildSnapshot(): Promise<ProcessSnapshotEntry[]> {
    const procs = listProcesses();
    const byPid = new Map<number, ProcInfo>();
    for (const p of procs) {
      byPid.set(p.pid, p);
    }

    // Pre-classify every process so we can detect agentapi ancestors AND
    // meridian-hub ancestors (codex/claude under calling-hub are the hub's,
    // not meridian-roles').
    const agentapiPids = new Set<number>();
    const meridianHubPids = new Set<number>();
    for (const p of procs) {
      if (AGENTAPI_COMMAND_PATTERN.test(p.command)) {
        agentapiPids.add(p.pid);
      }
      if (
        MERIDIAN_HUB_PROCESS_PATTERN.test(p.command)
        || MERIDIAN_HUB_NODE_PATTERN.test(p.command)
        || MERIDIAN_HUB_RELATIVE_NODE_PATTERN.test(p.command)
      ) {
        meridianHubPids.add(p.pid);
      }
    }

    const candidates = procs.filter((p) => isAgentShaped(p.command));
    const index = await buildThreadIndex(options.stateStore, log);

    // Build the Hub instance view ONCE per request (when wired). The full list
    // supplies two things:
    //   1. pid → thread_id fallback for TCP-port agentapi / Hub-direct calls.
    //   2. synthetic rows for lifecycle-bound bridge threads that are alive in
    //      Hub but currently have no OS child process.
    let hubInstances: AgentInstance[] = [];
    let pidToThreadId: Map<number, string> | null = null;
    if (options.fetchAgentapiInstances) {
      try {
        hubInstances = await options.fetchAgentapiInstances();
        pidToThreadId = buildPidToThreadIdFromInstances(hubInstances);
      } catch (error) {
        log.debug?.("processes: fetchAgentapiInstances failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        hubInstances = [];
        pidToThreadId = null;
      }
    }
    if (!pidToThreadId && options.fetchAgentapiInstanceIndex) {
      try {
        pidToThreadId = await options.fetchAgentapiInstanceIndex();
      } catch (error) {
        log.debug?.("processes: fetchAgentapiInstanceIndex failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        pidToThreadId = null;
      }
    }
    const resolveByPid = pidToThreadId
      ? (pid: number, port: number | null): string | null => {
          void port;
          return pidToThreadId?.get(pid) ?? null;
        }
      : null;

    const entries: ProcessSnapshotEntry[] = candidates
      .map((p) => {
        const agentType = detectAgentType(p.command);
        const isAgentapi = agentType === "agentapi";
        const directSocketMatch = p.command.match(AGENTAPI_SOCKET_PATTERN);
        const portMatch = p.command.match(AGENTAPI_PORT_PATTERN);
        const port = portMatch ? Number.parseInt(portMatch[1] ?? "", 10) : null;
        let threadId: string | null = directSocketMatch?.[1] ?? null;

        // Fallback: when agentapi runs on a TCP port (kernel didn't support
        // --socket), or when a validator/PM is Hub-direct `codex exec`, argv
        // has no thread marker. Use the Hub instance registry keyed by PID.
        if (!threadId && resolveByPid) {
          threadId = resolveByPid(p.pid, Number.isFinite(port) ? port : null);
        }

        // Walk the PPID chain to find an agentapi ancestor (codex/claude CLI
        // is the agentapi *child*).
        let ancestorAgentapi: ProcInfo | null = null;
        if (!isAgentapi) {
          ancestorAgentapi = findAgentapiAncestor(p, byPid, agentapiPids);
          if (ancestorAgentapi) {
            const ancestorSocket = ancestorAgentapi.command.match(AGENTAPI_SOCKET_PATTERN);
            if (ancestorSocket && !threadId) {
              threadId = ancestorSocket[1];
            }
            // TCP-port fallback for the ancestor too.
            if (!threadId && resolveByPid) {
              const ancestorPortMatch = ancestorAgentapi.command.match(AGENTAPI_PORT_PATTERN);
              const ancestorPort = ancestorPortMatch ? Number.parseInt(ancestorPortMatch[1] ?? "", 10) : null;
              threadId = resolveByPid(ancestorAgentapi.pid, Number.isFinite(ancestorPort) ? ancestorPort : null);
            }
          }
          if (!threadId && resolveByPid) {
            threadId = resolveThreadIdFromPidMappedAncestor(p, byPid, resolveByPid);
          }
        }

        // Origin classification. The Meridian Hub never autonomously spawns
        // anything — `handleSpawn` in Meridian/src/hub/router.ts only fires
        // in response to inbound HubMessage { intent: "spawn" } from a caller.
        // So ANY agent-shaped process whose PPID chain reaches the Hub was
        // *requested* by something (overwhelmingly meridian-roles itself, via
        // worker launcher / validator-orchestrator / pm-resolver paths). All
        // such processes are `managed`, not external.
        //
        // Order (each rule is sufficient by itself):
        //   1. This IS agentapi → managed.
        //   2. Has an agentapi PPID ancestor → managed (codex/claude child).
        //   3. Has a Meridian Hub PPID ancestor → managed (Hub-direct spawn
        //      requested by meridian-roles or another caller; pattern: codex
        //      `exec --json` for stateless validator calls).
        //   4. Argv has meridian-roles spawn markers but no agentapi/Hub
        //      ancestor → orphan (agentapi died, child reparented to init).
        //   5. Else external (user terminal, Claude Code session, etc.).
        let origin: ProcessOrigin;
        if (isAgentapi || ancestorAgentapi) {
          origin = "managed";
        } else if (findMeridianHubAncestor(p, byPid, meridianHubPids)) {
          // Hub-direct spawn (e.g. `codex exec --json`). Caller is recorded by
          // the Hub but isn't visible from `ps` alone. Treated as managed —
          // operator sees them and decides if the count is unexpectedly high.
          origin = "managed";
        } else if (
          (agentType === "codex" || agentType === "claude")
          && looksLikeMeridianOrphan(p.command)
          && isReparentedToInit(p, byPid)
        ) {
          // Argv looks like a meridian-roles spawn template AND the process
          // (or one of its ancestors) was reparented to init — i.e. the
          // original agentapi parent really did die. Without the reparenting
          // check, a user running `codex --dangerously-bypass-approvals-and-sandbox`
          // from their own shell (PPID chain leads to a live -zsh, never to
          // PID 1) would be misclassified as orphan. Observed live 2026-05-17:
          // codex 8701 PPID=81108 (-zsh, alive) flagged orphan.
          origin = "orphan";
        } else {
          origin = "external";
        }

        const binding = threadId ? (index.get(threadId) ?? null) : null;
        // Leak classification (managed origin, no binding):
        //   - agentapi: always a leak when unbound. An agentapi process exists
        //     to wrap exactly one agent session for one thread_id; an alive
        //     agentapi we can't bind is either a spawn-orphan (see
        //     learnings/dispatcher/spawn-http-timeout-too-short-and-retry-orphans.md)
        //     or a TCP-port agentapi with no fetchAgentapiInstanceIndex wired
        //     (the canonical "unbindable agentapi" pattern).
        //   - codex / claude with a parseable thread_id: leak (the same
        //     spawn-orphan fingerprint, applied to the CLI child).
        //   - codex / claude with NO thread_id: NOT a leak. These are
        //     Hub-direct stateless calls (`codex exec --json` forked by
        //     Meridian Hub for validator turns, `claude --print` for one-shot
        //     subprocess work) — no agentapi wrapper, no thread_id by design,
        //     they self-reap when the call finishes. Pre-this-fix they were
        //     flagged red and obscured the real leaks they sit next to.
        const isLeakable = agentType === "agentapi" || threadId !== null;
        const isLeak =
          (origin === "managed" && binding === null && isLeakable)
          || origin === "orphan";

        // Token usage: only meaningful for codex/claude. agentapi rows
        // never consume tokens themselves — the codex/claude child does.
        // The shim+native pair both resolve to the same session file via
        // cwd + start-time match, so they correctly show identical totals.
        let tokenUsage: TokenUsage | null = null;
        if (tokenUsageCollector && (agentType === "codex" || agentType === "claude")) {
          try {
            tokenUsage = tokenUsageCollector.lookup(p.pid, agentType, p.command);
          } catch (error) {
            log.debug?.("processes: token usage lookup failed", {
              pid: p.pid,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }

        return {
          pid: p.pid,
          ppid: p.ppid,
          etime: p.etime,
          agent_type: agentType,
          thread_id: threadId,
          origin,
          binding,
          is_leak: isLeak,
          command: p.command,
          token_usage: tokenUsage
        };
      });

    // Stateless validator / PM inference pass. Meridian Hub spawns validators
    // (in `stateless_call` mode) and pm-resolvers as `codex exec --json` and
    // does NOT keep the resulting thread in its /api/list instance index after
    // returning, so `fetchAgentapiInstanceIndex` cannot map their PID to the
    // thread_id the lifecycle store knows about. Without this pass the live
    // stateless-call process tree (a node-shim PID + native-binary PID, parent
    // is the meridian-hub process) lands in the Processes tab as an unbound
    // "stateless" group even though the dispatcher knows it's a validator/PM
    // working on a specific worker. That makes operators read the unbound
    // group as "the actual worker" and the bound worker group as "ghost" —
    // exactly the misread reported 2026-05-20 (PIDs 90194/90195 with active
    // tokens read as Worker A2 while the real worker 90191/92/93 read as
    // dead, when 90194/95 was actually the validator for A2).
    //
    // Inference rules (conservative, no PPID/cwd matching to avoid false
    // positives in multi-dispatcher concurrency):
    //   - Build a list of active stateless owners from the lifecycle store
    //     (any worker.validation.validator_thread_id set, plus any
    //     pm_resolvers entry with status="running").
    //   - For each unbound managed `codex exec --json` process, find the
    //     unique candidate owner whose `started_at` is within 60s of the
    //     process's elapsed-time-derived start window. When exactly ONE owner
    //     matches, synthesize a binding. When zero or multiple match, leave
    //     unbound — better to show a labeled stateless group than to attach
    //     a wrong worker.
    const activeOwners = await buildActiveStatelessOwners(options.stateStore, log);
    bindUnboundCodexExecOwners(entries, byPid, activeOwners, {
      allowSingletonFallback: true
    });

    // Streaming bridge inference pass. Since 2026-05-21 Meridian registers
    // stream-capable bridge instances as metadata-only (`pid: null`,
    // `socket_path: null`) and each run forks a Hub-child `codex exec --json`
    // process. That means the Hub instance registry cannot provide a pid →
    // thread_id mapping for dispatcher/worker bridge turns. Bind remaining
    // unbound codex-exec roots to active dispatcher/worker lifecycle owners
    // only when exactly one owner start time matches the process start window.
    const activeBridgeOwners = await buildActiveStreamingBridgeOwners(options.stateStore, log);
    bindUnboundCodexExecOwners(entries, byPid, activeBridgeOwners, {
      allowSingletonFallback: false
    });

    bindUnboundHubStreamingBridgeRuns(entries, byPid, buildActiveHubStreamingBridgeOwners(hubInstances));

    appendHubInstanceOnlyRows(entries, hubInstances, index);

    // Token-attribution dedupe: claude resolves via cwd + birthtime match, so
    // a Hub-direct `claude --print` started near the same time in the same
    // cwd as a bound agentapi-managed claude often resolves to the SAME
    // session_file (the closest-birthtime match wins for both). The agentapi
    // shim+native pair sharing a file is legitimate (PPID-paired, both bound
    // to the same codex_NN); an unrelated Hub-direct call grabbing a bound
    // peer's session_file is misattribution and inflates the per-row token
    // display. When a session_file is claimed by ANY bound row, strip the
    // attribution from unbound rows pointing at the same file so the totals
    // surface against the actually-responsible thread only.
    const sessionFilesClaimedByBound = new Set<string>();
    for (const entry of entries) {
      if (entry.binding !== null && entry.token_usage) {
        sessionFilesClaimedByBound.add(entry.token_usage.session_file);
      }
    }
    for (const entry of entries) {
      if (
        entry.binding === null
        && entry.token_usage
        && sessionFilesClaimedByBound.has(entry.token_usage.session_file)
      ) {
        entry.token_usage = null;
      }
    }

    return entries.sort((a, b) => {
      const order = (e: ProcessSnapshotEntry) =>
        e.is_leak ? 0 : e.origin === "managed" ? 1 : e.origin === "hub" ? 2 : 3;
      const diff = order(a) - order(b);
      if (diff !== 0) return diff;
      const pidDiff = processSortPid(a) - processSortPid(b);
      if (pidDiff !== 0) return pidDiff;
      return (a.thread_id ?? "").localeCompare(b.thread_id ?? "");
    });
  }

  return {
    async handle(request, response) {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "GET" || url.pathname !== "/api/agentapi-processes") {
        return false;
      }
      try {
        const snapshot = await buildSnapshot();
        if (tokenUsageCollector) {
          tokenUsageCollector.retain(new Set(snapshot.map((e) => e.pid).filter((pid): pid is number => pid !== null)));
        }
        const managed = snapshot.filter((e) => e.origin === "managed");
        const hub = snapshot.filter((e) => e.origin === "hub");
        const external = snapshot.filter((e) => e.origin === "external");
        const orphan = snapshot.filter((e) => e.origin === "orphan");
        const leak = snapshot.filter((e) => e.is_leak).length;
        // Dedupe token totals per session file — shim + native + (rarely)
        // sibling agentapi rows would otherwise multi-count one session.
        const tokenTotals = summarizeTokenUsage(snapshot);
        writeJson(response, 200, {
          captured_at: new Date().toISOString(),
          total: snapshot.length,
          managed_bound: managed.filter((e) => e.binding !== null).length,
          // managed_leak must agree with the per-row is_leak so the GUI summary
          // badge ("N leaks") matches what the row-level red dots show. Pre-
          // fix this was `binding === null`, which counted Hub-direct stateless
          // calls (no thread_id) as managed_leak even though is_leak excludes
          // them — the badge and the row indicators contradicted each other.
          managed_leak: managed.filter((e) => e.is_leak).length,
          hub_managed: hub.length,
          orphan: orphan.length,
          external: external.length,
          leak,
          token_totals: tokenTotals,
          processes: snapshot
        });
      } catch (error) {
        log.warn("/api/agentapi-processes failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        writeJson(response, 500, { error: "process snapshot failed" });
      }
      return true;
    }
  };
}

export async function buildProcessSnapshot(options: ProcessHandlersOptions): Promise<ProcessSnapshotEntry[]> {
  let captured = "";
  const response = {
    statusCode: 0,
    setHeader() {
      return response as unknown as ServerResponse;
    },
    end(payload?: string) {
      captured = payload ?? "";
      return response as unknown as ServerResponse;
    }
  };
  const handled = await createProcessHandlers(options).handle(
    { method: "GET", url: "/api/agentapi-processes" } as IncomingMessage,
    response as unknown as ServerResponse
  );
  if (!handled) {
    throw new Error("process snapshot route was not handled");
  }
  if (response.statusCode !== 200) {
    throw new Error("process snapshot failed");
  }
  const payload = JSON.parse(captured) as { processes?: unknown };
  return Array.isArray(payload.processes) ? payload.processes as ProcessSnapshotEntry[] : [];
}

interface TokenTotals {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  sessions: number;
}

// Sum cumulative token totals across snapshot rows, deduping by session_file
// so paired shim+native rows (which both surface the same session) contribute
// only once.
function summarizeTokenUsage(entries: ProcessSnapshotEntry[]): TokenTotals {
  const perFile = new Map<string, TokenUsage>();
  for (const e of entries) {
    if (e.token_usage) {
      perFile.set(e.token_usage.session_file, e.token_usage);
    }
  }
  const totals: TokenTotals = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    sessions: perFile.size
  };
  for (const u of perFile.values()) {
    totals.input_tokens += u.input_tokens;
    totals.cached_input_tokens += u.cached_input_tokens;
    totals.output_tokens += u.output_tokens;
    totals.reasoning_output_tokens += u.reasoning_output_tokens;
    totals.total_tokens += u.total_tokens;
  }
  return totals;
}

function processSortPid(entry: ProcessSnapshotEntry): number {
  return entry.pid ?? Number.MAX_SAFE_INTEGER;
}

function isAgentShaped(command: string): boolean {
  return (
    AGENTAPI_COMMAND_PATTERN.test(command)
    || CODEX_COMMAND_PATTERN.test(command)
    || CLAUDE_COMMAND_PATTERN.test(command)
  );
}

function detectAgentType(command: string): "agentapi" | "codex" | "claude" | null {
  if (AGENTAPI_COMMAND_PATTERN.test(command)) {
    return "agentapi";
  }
  // Order matters: codex shim via `node .../codex` mustn't be misread as claude.
  if (CODEX_COMMAND_PATTERN.test(command)) {
    return "codex";
  }
  if (CLAUDE_COMMAND_PATTERN.test(command)) {
    return "claude";
  }
  return null;
}

// Distinguish "orphan codex from a dead agentapi" (a leak we need to surface)
// from "user-spawned codex in a terminal" (external — leave alone). The
// surest marker is the meridian-roles spawn template, which passes
// `--dangerously-bypass-approvals-and-sandbox` to codex. User terminal codex
// invocations almost never use that flag.
function looksLikeMeridianOrphan(command: string): boolean {
  return /--dangerously-bypass-approvals-and-sandbox/.test(command)
    || /-c\s+model_reasoning_effort/.test(command);
}

// Walks PPID chain (bounded to 8 steps for safety). Returns the first ancestor
// whose argv matches AGENTAPI_COMMAND_PATTERN, or null.
function findAgentapiAncestor(
  start: ProcInfo,
  byPid: Map<number, ProcInfo>,
  agentapiPids: Set<number>
): ProcInfo | null {
  let cursor: ProcInfo | undefined = start;
  for (let depth = 0; depth < 8 && cursor; depth += 1) {
    if (cursor.ppid === 0 || cursor.ppid === 1) {
      return null;
    }
    const parent = byPid.get(cursor.ppid);
    if (!parent) {
      return null;
    }
    if (agentapiPids.has(parent.pid)) {
      return parent;
    }
    cursor = parent;
  }
  return null;
}

// Walks the PPID chain looking for reparenting to PID 1 *while still inside
// the codex/claude/shim chain*. A real "orphan" has its agentapi parent
// killed, leaving the codex shim with PPID=1 (and the native binary still
// childed to the shim). A user-launched codex has a real shell ancestor —
// when we step out of the agent chain to a non-agent process, that process
// is the owner, so it's external regardless of whether the shell eventually
// reaches launchd (PID 1) further up the tree.
//
// Note: a naive "any ancestor has PPID=1" check is wrong on macOS because
// the user's terminal app (iTerm, Terminal.app) is itself a child of
// launchd (PID 1). The check must stop as soon as a non-agent owner appears.
function isReparentedToInit(
  start: ProcInfo,
  byPid: Map<number, ProcInfo>
): boolean {
  let cursor: ProcInfo | undefined = start;
  for (let depth = 0; depth < 8 && cursor; depth += 1) {
    if (cursor.ppid === 1) {
      return true;
    }
    if (cursor.ppid === 0) {
      return false;
    }
    const parent = byPid.get(cursor.ppid);
    if (!parent) {
      // Parent vanished from ps mid-snapshot — treat as reparented.
      return true;
    }
    if (!isAgentShaped(parent.command)) {
      // Stepped out of the agent chain to a real owner (shell, terminal,
      // hub, etc). Not a reparented orphan.
      return false;
    }
    cursor = parent;
  }
  return false;
}

// Like findAgentapiAncestor, but searches for a Meridian hub process
// (calling-hub PM2 wrapper or the underlying node /Meridian/dist/hub/...
// invocation). Used to exclude hub-spawned codex/claude from the
// orphan/leak classification.
function findMeridianHubAncestor(
  start: ProcInfo,
  byPid: Map<number, ProcInfo>,
  meridianHubPids: Set<number>
): ProcInfo | null {
  let cursor: ProcInfo | undefined = start;
  for (let depth = 0; depth < 8 && cursor; depth += 1) {
    if (cursor.ppid === 0 || cursor.ppid === 1) {
      return null;
    }
    const parent = byPid.get(cursor.ppid);
    if (!parent) {
      return null;
    }
    if (meridianHubPids.has(parent.pid)) {
      return parent;
    }
    cursor = parent;
  }
  return null;
}

// Hub-direct `codex exec` spawns a node shim (registered in the Hub instance
// index) plus a native codex child (not registered). Let the child inherit the
// shim's thread_id so the two rows bind to the same validator/PM owner.
function resolveThreadIdFromPidMappedAncestor(
  start: ProcInfo,
  byPid: Map<number, ProcInfo>,
  resolveByPid: (pid: number, port: number | null) => string | null
): string | null {
  let cursor: ProcInfo | undefined = start;
  for (let depth = 0; depth < 8 && cursor; depth += 1) {
    if (cursor.ppid === 0 || cursor.ppid === 1) {
      return null;
    }
    const parent = byPid.get(cursor.ppid);
    if (!parent) {
      return null;
    }
    const portMatch = parent.command.match(AGENTAPI_PORT_PATTERN);
    const port = portMatch ? Number.parseInt(portMatch[1] ?? "", 10) : null;
    const threadId = resolveByPid(parent.pid, Number.isFinite(port) ? port : null);
    if (threadId) {
      return threadId;
    }
    if (!isAgentShaped(parent.command)) {
      return null;
    }
    cursor = parent;
  }
  return null;
}

function buildPidToThreadIdFromInstances(instances: AgentInstance[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const inst of instances) {
    if (typeof inst.pid === "number" && inst.pid > 0 && inst.thread_id) {
      map.set(inst.pid, inst.thread_id);
    }
  }
  return map;
}

function appendHubInstanceOnlyRows(
  entries: ProcessSnapshotEntry[],
  hubInstances: AgentInstance[],
  index: Map<string, BindingSnapshot>
): void {
  if (hubInstances.length === 0) {
    return;
  }

  const seenThreadIds = new Set(
    entries
      .map((entry) => entry.thread_id)
      .filter((threadId): threadId is string => typeof threadId === "string" && threadId.trim().length > 0)
  );

  for (const inst of hubInstances) {
    const threadId = inst.thread_id?.trim();
    if (!threadId || seenThreadIds.has(threadId)) {
      continue;
    }
    if (!LIVE_HUB_INSTANCE_STATUSES.has(inst.status)) {
      continue;
    }

    const binding = index.get(threadId) ?? null;

    entries.push({
      pid: null,
      ppid: null,
      etime: "",
      agent_type: inst.agent_type,
      thread_id: threadId,
      origin: binding ? "managed" : "hub",
      binding,
      is_leak: false,
      command: formatHubInstanceCommand(inst),
      token_usage: null
    });
    seenThreadIds.add(threadId);
  }
}

function formatHubInstanceCommand(inst: AgentInstance): string {
  const parts = [
    "meridian-hub instance",
    `mode=${inst.mode}`,
    `status=${inst.status}`,
    `pid=${inst.pid ?? "null"}`,
    `socket=${inst.socket_path ?? "null"}`
  ];
  if (inst.model_id) {
    parts.push(`model=${inst.model_id}`);
  }
  return parts.join(" ");
}

async function buildThreadIndex(
  stateStore: Pick<StateStore, "load">,
  log: Logger
): Promise<Map<string, BindingSnapshot>> {
  const index = new Map<string, BindingSnapshot>();
  const stateRaw = await stateStore.load();
  const state = (stateRaw ?? { roles: [], promptStore: {} }) as AppState;
  for (const role of state.roles) {
    if (role.roleType !== "agent-dispatcher") {
      continue;
    }
    const parsed = AgentDispatcherConfigSchema.safeParse(role.config);
    if (!parsed.success) {
      continue;
    }
    const planPath = parsed.data.dispatch_plan_path;
    const sidecarPath = path.join(path.dirname(planPath), "dispatch_threads.json");
    let lifecycleState: DispatchThreadStateV2;
    try {
      lifecycleState = new LifecycleStore(sidecarPath).load();
    } catch (error) {
      log.debug?.("processes: failed to read sidecar", {
        sidecarPath,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    const dispThreadId = lifecycleState.dispatcher.thread_id;
    if (dispThreadId && lifecycleState.dispatcher.status === "running") {
      index.set(dispThreadId, {
        dispatcher_role_id: role.threadId,
        worker_id: "DISPATCHER",
        role: "dispatcher",
        status: lifecycleState.dispatcher.status,
        started_at: lifecycleState.dispatcher.started_at
      });
    }

    for (const [workerId, w] of Object.entries(lifecycleState.workers)) {
      if (workerId === DISPATCHER_WORKER_ID && w.thread_id === dispThreadId) {
        continue;
      }
      // Bind whenever the worker thread is one the run-tool intentionally
      // keeps alive (see tool-gateway/tools/run.ts:335 cleanupWorkerThread).
      // `awaiting_validation` / `fix_requested` / `blocked` all keep the
      // codex worker process alive on purpose: awaiting_validation hands the
      // session to the validator (and on validator REJECT the dispatcher
      // delivers feedback to the SAME thread to reuse the rollout cache —
      // validator-orchestrator.ts:530), fix_requested may be either mid-
      // feedback-delivery or transport-stall-preserved, blocked may be
      // PM-resolver-pending. Treating these as unbound paints the live
      // worker as "no dispatcher claim" in the Processes tab and is a false
      // leak signal. The bug was originally observed on
      // agent-dispatcher-00f759ff codex_15. Terminal states (`completed` /
      // `failed` / `abandoned` / `skipped`) deliberately remain unbound:
      // their `thread_id` is an audit row and a surviving codex IS a leak.
      if (!w.thread_id || !isLiveWorkerStatus(w.status)) {
        continue;
      }
      index.set(w.thread_id, {
        dispatcher_role_id: role.threadId,
        worker_id: workerId,
        role: "worker",
        status: w.status,
        started_at: w.started_at ?? null
      });
    }

    for (const [workerId, w] of Object.entries(lifecycleState.workers)) {
      const validation = (w as unknown as {
        validation?: { validator_thread_id?: string | null };
      }).validation;
      const validatorThreadId = validation?.validator_thread_id?.trim();
      // Bind whenever the lifecycle store has an active validator_thread_id —
      // do NOT gate on `w.status === "awaiting_validation"`. validator_thread_id
      // is cleared by recordValidationOutcome / clearValidatorStart on
      // completion, so a non-empty value already means "validator is active".
      // Gating on awaiting_validation missed two real cases observed live
      // 2026-05-20: (a) stateless_call validators that finish a turn while the
      // worker has already transitioned to `completed` via output-artifact
      // recovery, and (b) transport-stall paths where the validator stays
      // recorded with the worker in `blocked` for late-verdict recovery
      // (`validator_run_transport_stall_codex_alive` event). Both are visible
      // running validator processes that the Processes tab used to leave
      // unbound, dumping them into the "stateless" bucket.
      if (!validatorThreadId) {
        continue;
      }
      index.set(validatorThreadId, {
        dispatcher_role_id: role.threadId,
        worker_id: workerId,
        role: "validator",
        status: "running",
        started_at: w.last_seen_at ?? w.started_at ?? null
      });
    }

    const pmResolvers = (lifecycleState as unknown as {
      pm_resolvers?: Array<{
        thread_id?: string;
        // Top-level `worker_id` is never written by the production recording
        // paths (startPmResolverForRole / recordPmResolverResult); the worker
        // the PM is targeting always lives at `issue.worker_id`. The top-level
        // alias is read defensively in case a future call site adopts it.
        worker_id?: string;
        status?: string;
        started_at?: string;
        issue?: { worker_id?: string };
      }>;
    }).pm_resolvers ?? [];
    for (const pm of pmResolvers) {
      if (!pm.thread_id || pm.status !== "running") {
        continue;
      }
      index.set(pm.thread_id, {
        dispatcher_role_id: role.threadId,
        worker_id: pm.worker_id ?? pm.issue?.worker_id ?? "(unknown)",
        role: "pm_resolver",
        status: pm.status,
        started_at: pm.started_at ?? null
      });
    }

    // Note: validation.history entries are appended only after a validator
    // produces a verdict (lifecycle-store.ts:recordValidationOutcome) and the
    // recorded shape is `{cycle, score, feedback, validator_thread_id,
    // timestamp}` — there is no `status` field. The previous loop here looked
    // for `entry.status === "running"` which never matched anything, so it was
    // dead code that gave a false sense of "history is covered". A
    // currently-running validator now lives at `validation.validator_thread_id`
    // (bound above) and a previously-finished validator should NOT bind
    // because the verdict is already in the lifecycle and the codex process
    // has been killed by the orchestrator. Dropped intentionally.
  }

  return index;
}

const PROCESS_OWNER_START_TOLERANCE_MS = 60 * 1000;

interface ActiveProcessOwner {
  thread_id: string;
  dispatcher_role_id: string;
  worker_id: string;
  role: BindingSnapshot["role"];
  status: string;
  started_at: string | null;
}

// Lifecycle-store snapshot of validator / PM resolver threads that are
// currently active (recorded as "running" with a non-empty thread_id). Used by
// the inference pass in buildSnapshot() to bind stateless `codex exec --json`
// processes that Meridian Hub does not expose via /api/list (and therefore
// `fetchAgentapiInstanceIndex` cannot map their PID).
export interface ActiveStatelessOwner extends ActiveProcessOwner {
  thread_id: string;          // lifecycle-recorded thread_id (e.g. "codex_08")
  role: "validator" | "pm_resolver";
  status: "running";
}

async function buildActiveStatelessOwners(
  stateStore: Pick<StateStore, "load">,
  log: Logger
): Promise<ActiveStatelessOwner[]> {
  const owners: ActiveStatelessOwner[] = [];
  const stateRaw = await stateStore.load();
  const state = (stateRaw ?? { roles: [], promptStore: {} }) as AppState;
  for (const role of state.roles) {
    if (role.roleType !== "agent-dispatcher") {
      continue;
    }
    const parsed = AgentDispatcherConfigSchema.safeParse(role.config);
    if (!parsed.success) {
      continue;
    }
    const planPath = parsed.data.dispatch_plan_path;
    const sidecarPath = path.join(path.dirname(planPath), "dispatch_threads.json");
    let lifecycleState: DispatchThreadStateV2;
    try {
      lifecycleState = new LifecycleStore(sidecarPath).load();
    } catch (error) {
      log.debug?.("processes: failed to read sidecar for stateless inference", {
        sidecarPath,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    for (const [workerId, w] of Object.entries(lifecycleState.workers)) {
      const validation = (w as unknown as {
        validation?: { validator_thread_id?: string | null };
      }).validation;
      const tid = validation?.validator_thread_id?.trim();
      if (tid) {
        owners.push({
          thread_id: tid,
          dispatcher_role_id: role.threadId,
          worker_id: workerId,
          role: "validator",
          status: "running",
          started_at: w.last_seen_at ?? w.started_at ?? null
        });
      }
    }
    const pmResolvers = (lifecycleState as unknown as {
      pm_resolvers?: Array<{
        thread_id?: string;
        worker_id?: string;
        status?: string;
        started_at?: string;
        issue?: { worker_id?: string };
      }>;
    }).pm_resolvers ?? [];
    for (const pm of pmResolvers) {
      if (!pm.thread_id || pm.status !== "running") continue;
      owners.push({
        thread_id: pm.thread_id,
        dispatcher_role_id: role.threadId,
        worker_id: pm.worker_id ?? pm.issue?.worker_id ?? "(unknown)",
        role: "pm_resolver",
        status: "running",
        started_at: pm.started_at ?? null
      });
    }
  }
  return owners;
}

interface ActiveStreamingBridgeOwner extends ActiveProcessOwner {
  role: "dispatcher" | "worker";
}

interface ActiveHubStreamingBridgeOwner {
  thread_id: string;
  agent_type: AgentInstance["agent_type"];
  status: AgentInstance["status"];
  started_at: string | null;
  codex_session_id: string | null;
}

async function buildActiveStreamingBridgeOwners(
  stateStore: Pick<StateStore, "load">,
  log: Logger
): Promise<ActiveStreamingBridgeOwner[]> {
  const owners: ActiveStreamingBridgeOwner[] = [];
  const stateRaw = await stateStore.load();
  const state = (stateRaw ?? { roles: [], promptStore: {} }) as AppState;
  for (const role of state.roles) {
    if (role.roleType !== "agent-dispatcher") {
      continue;
    }
    const parsed = AgentDispatcherConfigSchema.safeParse(role.config);
    if (!parsed.success) {
      continue;
    }
    const planPath = parsed.data.dispatch_plan_path;
    const sidecarPath = path.join(path.dirname(planPath), "dispatch_threads.json");
    let lifecycleState: DispatchThreadStateV2;
    try {
      lifecycleState = new LifecycleStore(sidecarPath).load();
    } catch (error) {
      log.debug?.("processes: failed to read sidecar for streaming bridge inference", {
        sidecarPath,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    const dispatcherThreadId = lifecycleState.dispatcher.thread_id?.trim();
    if (dispatcherThreadId && lifecycleState.dispatcher.status === "running") {
      owners.push({
        thread_id: dispatcherThreadId,
        dispatcher_role_id: role.threadId,
        worker_id: "DISPATCHER",
        role: "dispatcher",
        status: lifecycleState.dispatcher.status,
        started_at: lifecycleState.dispatcher.started_at
      });
    }

    for (const [workerId, worker] of Object.entries(lifecycleState.workers)) {
      const workerThreadId = worker.thread_id?.trim();
      if (workerId === DISPATCHER_WORKER_ID && workerThreadId === dispatcherThreadId) {
        continue;
      }
      if (!workerThreadId || !isLiveWorkerStatus(worker.status)) {
        continue;
      }
      owners.push({
        thread_id: workerThreadId,
        dispatcher_role_id: role.threadId,
        worker_id: workerId,
        role: "worker",
        status: worker.status,
        started_at: worker.started_at ?? null
      });
    }
  }
  return owners;
}

function buildActiveHubStreamingBridgeOwners(instances: AgentInstance[]): ActiveHubStreamingBridgeOwner[] {
  const owners: ActiveHubStreamingBridgeOwner[] = [];
  for (const inst of instances) {
    const threadId = inst.thread_id?.trim();
    if (!threadId) {
      continue;
    }
    if (inst.mode !== "bridge" || inst.status !== "running") {
      continue;
    }
    if (inst.agent_type !== "codex" && inst.agent_type !== "claude") {
      continue;
    }
    if (inst.supportsStream !== true && inst.socket_path !== null) {
      continue;
    }
    const lastInteractionAt = typeof inst.last_interaction_at === "string"
      && inst.last_interaction_at.trim().length > 0
      ? inst.last_interaction_at.trim()
      : null;
    owners.push({
      thread_id: threadId,
      agent_type: inst.agent_type,
      status: inst.status,
      started_at: lastInteractionAt,
      codex_session_id: typeof inst.codexSessionId === "string" && inst.codexSessionId.trim().length > 0
        ? inst.codexSessionId.trim()
        : null
    });
  }
  return owners;
}

function bindUnboundHubStreamingBridgeRuns(
  entries: ProcessSnapshotEntry[],
  byPid: Map<number, ProcInfo>,
  owners: ActiveHubStreamingBridgeOwner[]
): void {
  if (owners.length === 0) {
    return;
  }

  const candidates = collectUnboundHubStreamRoots(entries, byPid);
  if (candidates.length === 0) {
    return;
  }

  const usedOwnerThreadIds = new Set<string>();
  const nowMs = Date.now();
  for (const root of candidates) {
    const startMs = approximateStartMs(root.etime, nowMs);
    const resumeSessionId = root.agent_type === "codex"
      ? extractCodexResumeSessionId(root.command)
      : null;
    const matches: ActiveHubStreamingBridgeOwner[] = [];

    for (const owner of owners) {
      if (usedOwnerThreadIds.has(owner.thread_id)) {
        continue;
      }
      if (owner.agent_type !== root.agent_type) {
        continue;
      }
      if (
        owner.agent_type === "codex"
        && owner.codex_session_id
        && resumeSessionId
        && owner.codex_session_id === resumeSessionId
      ) {
        matches.push(owner);
        continue;
      }
      if (!owner.started_at || startMs === null) {
        continue;
      }
      const ownerMs = Date.parse(owner.started_at);
      if (!Number.isFinite(ownerMs)) {
        continue;
      }
      if (Math.abs(ownerMs - startMs) <= PROCESS_OWNER_START_TOLERANCE_MS) {
        matches.push(owner);
      }
    }

    if (matches.length !== 1) {
      continue;
    }

    const chosen = matches[0];
    usedOwnerThreadIds.add(chosen.thread_id);
    markHubOwnedRun(root, chosen.thread_id);
    if (root.pid === null) {
      continue;
    }
    for (const descendant of descendantsOf(root.pid, entries)) {
      markHubOwnedRun(descendant, chosen.thread_id);
    }
  }
}

function markHubOwnedRun(entry: ProcessSnapshotEntry, threadId: string): void {
  entry.origin = "hub";
  entry.thread_id = threadId;
  entry.binding = null;
  entry.is_leak = false;
}

function bindUnboundCodexExecOwners(
  entries: ProcessSnapshotEntry[],
  byPid: Map<number, ProcInfo>,
  owners: ActiveProcessOwner[],
  options: { allowSingletonFallback: boolean }
): void {
  if (owners.length === 0) {
    return;
  }

  const candidates = collectUnboundCodexExecRoots(entries, byPid);
  if (candidates.length === 0) {
    return;
  }

  const usedOwnerThreadIds = new Set<string>();
  const nowMs = Date.now();
  for (const root of candidates) {
    const startMs = approximateStartMs(root.etime, nowMs);
    if (startMs === null) {
      continue;
    }

    const matches: ActiveProcessOwner[] = [];
    for (const owner of owners) {
      if (usedOwnerThreadIds.has(owner.thread_id)) {
        continue;
      }
      if (!owner.started_at) {
        continue;
      }
      const ownerMs = Date.parse(owner.started_at);
      if (!Number.isFinite(ownerMs)) {
        continue;
      }
      if (Math.abs(ownerMs - startMs) <= PROCESS_OWNER_START_TOLERANCE_MS) {
        matches.push(owner);
      }
    }

    let chosen: ActiveProcessOwner | null = null;
    if (matches.length === 1) {
      chosen = matches[0];
    } else if (
      options.allowSingletonFallback
      && matches.length === 0
      && candidates.length === 1
      && owners.length === 1
    ) {
      // Singleton fallback is intentionally limited to stateless validator/PM
      // inference. Streaming bridge owners always carry a started_at in the
      // lifecycle store, and timestamp ambiguity should leave the row unbound.
      chosen = owners[0];
    }

    if (!chosen) {
      continue;
    }

    usedOwnerThreadIds.add(chosen.thread_id);
    const binding: BindingSnapshot = {
      dispatcher_role_id: chosen.dispatcher_role_id,
      worker_id: chosen.worker_id,
      role: chosen.role,
      status: chosen.status,
      started_at: chosen.started_at
    };
    root.binding = binding;
    root.thread_id = chosen.thread_id;
    if (root.pid === null) {
      continue;
    }
    for (const descendant of descendantsOf(root.pid, entries)) {
      descendant.binding = binding;
      descendant.thread_id = chosen.thread_id;
    }
  }
}

function collectUnboundCodexExecRoots(
  entries: ProcessSnapshotEntry[],
  byPid: Map<number, ProcInfo>
): ProcessSnapshotEntry[] {
  const candidates: ProcessSnapshotEntry[] = [];
  for (const entry of entries) {
    if (entry.origin !== "managed") continue;
    if (entry.binding !== null) continue;
    if (entry.thread_id !== null) continue;
    if (entry.agent_type !== "codex") continue;
    if (!CODEX_EXEC_JSON_PATTERN.test(entry.command)) continue;
    if (entry.ppid === null) continue;
    // Root = whichever PID's parent is not also a `codex exec --json`
    // process. The native binary's parent is the node shim, so the shim is
    // the root and descendants inherit the synthesized binding.
    const parent = byPid.get(entry.ppid);
    if (parent && CODEX_EXEC_JSON_PATTERN.test(parent.command)) continue;
    candidates.push(entry);
  }
  return candidates;
}

function collectUnboundHubStreamRoots(
  entries: ProcessSnapshotEntry[],
  byPid: Map<number, ProcInfo>
): ProcessSnapshotEntry[] {
  const candidates: ProcessSnapshotEntry[] = [];
  for (const entry of entries) {
    if (entry.origin !== "managed") continue;
    if (entry.binding !== null) continue;
    if (entry.thread_id !== null) continue;
    if (entry.ppid === null) continue;
    if (entry.agent_type === "codex") {
      if (!CODEX_EXEC_JSON_PATTERN.test(entry.command)) continue;
    } else if (entry.agent_type !== "claude") {
      continue;
    }

    const parent = byPid.get(entry.ppid);
    if (parent && isSameUnboundHubStreamProcess(parent.command, entry.agent_type)) {
      continue;
    }
    candidates.push(entry);
  }
  return candidates;
}

function isSameUnboundHubStreamProcess(command: string, agentType: ProcessSnapshotEntry["agent_type"]): boolean {
  if (agentType === "codex") {
    return CODEX_EXEC_JSON_PATTERN.test(command);
  }
  if (agentType === "claude") {
    return CLAUDE_COMMAND_PATTERN.test(command);
  }
  return false;
}

function descendantsOf(rootPid: number, entries: ProcessSnapshotEntry[]): ProcessSnapshotEntry[] {
  const out: ProcessSnapshotEntry[] = [];
  const stack = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (stack.length > 0) {
    const here = stack.pop()!;
    for (const entry of entries) {
      if (entry.pid === null || entry.ppid === null) continue;
      if (seen.has(entry.pid)) continue;
      if (entry.ppid !== here) continue;
      if (entry.origin !== "managed") continue;
      if (entry.thread_id !== null) continue;
      seen.add(entry.pid);
      out.push(entry);
      stack.push(entry.pid);
    }
  }
  return out;
}

function approximateStartMs(etime: string, nowMs: number): number | null {
  // ps etime forms: "MM:SS", "HH:MM:SS", "DD-HH:MM:SS". Parse to seconds.
  const match = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) {
    return null;
  }
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const mins = Number(match[3] ?? 0);
  const secs = Number(match[4] ?? 0);
  if (![days, hours, mins, secs].every(Number.isFinite)) {
    return null;
  }
  return nowMs - (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
}

function defaultListProcesses(): ProcInfo[] {
  try {
    const output = execFileSync("ps", ["-A", "-o", "pid,ppid,etime,command"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024
    });
    return output
      .split(/\r?\n/)
      .map((line) => parseLine(line))
      .filter((p): p is ProcInfo => p !== null);
  } catch {
    return [];
  }
}

function parseLine(line: string): ProcInfo | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
  if (!match) {
    return null;
  }
  const pid = Number.parseInt(match[1] ?? "", 10);
  const ppid = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(pid) || !Number.isFinite(ppid)) {
    return null;
  }
  return { pid, ppid, etime: match[3] ?? "", command: match[4] ?? "" };
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`${JSON.stringify(body)}\n`);
}

export const _internals = {
  AGENTAPI_SOCKET_PATTERN,
  AGENTAPI_COMMAND_PATTERN,
  CODEX_COMMAND_PATTERN,
  CLAUDE_COMMAND_PATTERN,
  CODEX_EXEC_JSON_PATTERN,
  MERIDIAN_HUB_NODE_PATTERN,
  MERIDIAN_HUB_RELATIVE_NODE_PATTERN,
  isAgentShaped,
  detectAgentType,
  looksLikeMeridianOrphan,
  isReparentedToInit,
  findAgentapiAncestor,
  parseLine,
  summarizeTokenUsage,
  buildActiveStatelessOwners
};
