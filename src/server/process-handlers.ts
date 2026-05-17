import { execFileSync } from "node:child_process";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { LifecycleStore } from "../roles/agent-dispatcher/lifecycle-store";
import type { Logger } from "../roles/base-role";
import type { StateStore } from "../state-store";
import { TokenUsageCollector, type TokenUsage } from "./token-usage";
import { AgentDispatcherConfigSchema, type DispatchThreadStateV2, type AppState } from "../types";

export interface ProcessHandlersOptions {
  stateStore: Pick<StateStore, "load">;
  log?: Logger;
  // Test seam — defaults to `ps -A -o pid,ppid,etime,command`.
  listProcesses?: () => ProcInfo[];
  // Optional: when Meridian Hub spawns agentapi via TCP port (the host kernel
  // doesn't support --socket), the agentapi argv has no /tmp/agentapi-<id>.sock
  // marker. The handler calls this once per request to fetch the Hub's
  // instance registry, then looks up `pid → thread_id` from it. If the call
  // throws or returns nothing, attribution falls back to socket-path parsing
  // only and unbound agentapi will (correctly) be flagged as a leak.
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
//   "external": agent-shaped process the user is running themselves
//               (terminal `codex`, interactive `claude`, Claude Code session,
//               other tools). NOT a leak — just noise the operator can
//               recognize at a glance.
//   "orphan":   meridian-roles AGENTAPI is gone but its codex/claude child
//               survived (the documented active-tool-process.ts:39 pattern).
//               Treated as a leak because operator needs to clean these up.
export type ProcessOrigin = "managed" | "external" | "orphan";

interface ProcessSnapshotEntry {
  pid: number;
  ppid: number;
  etime: string;
  agent_type: "agentapi" | "codex" | "claude" | null;
  thread_id: string | null;
  origin: ProcessOrigin;
  binding: BindingSnapshot | null;
  is_leak: boolean;
  command: string;
  token_usage: TokenUsage | null;
}

interface BindingSnapshot {
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
const AGENTAPI_TYPE_PATTERN = /--type=([a-zA-Z][\w-]*)/;
// `agentapi server` parent (real or symlinked binary path)
const AGENTAPI_COMMAND_PATTERN = /(?:^|[\s/])agentapi\s+server(?:\s|$)/;
// Codex CLI — bare `codex `, native binary path `.../codex/codex` or `.../codex`,
// or node-wrapped `node .../codex`. Matches the executable name after start, a
// path separator, or whitespace.
const CODEX_COMMAND_PATTERN = /(?:^|[\s/])codex(?:\s|$)/;
// Claude CLI — `claude --flag` or path-prefixed `.../claude --flag`.
const CLAUDE_COMMAND_PATTERN = /(?:^|[\s/])claude(?:\s|$)/;

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

    // Build the pid → thread_id map ONCE per request from the Hub instance
    // registry (when wired). Used as the TCP-port fallback for agentapi
    // processes whose argv lacks the canonical socket marker.
    let pidToThreadId: Map<number, string> | null = null;
    if (options.fetchAgentapiInstanceIndex) {
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
      ? (pid: number, _port: number | null): string | null => pidToThreadId?.get(pid) ?? null
      : null;

    return candidates
      .map((p) => {
        const agentType = detectAgentType(p.command);
        const isAgentapi = agentType === "agentapi";
        const directSocketMatch = p.command.match(AGENTAPI_SOCKET_PATTERN);
        const portMatch = p.command.match(AGENTAPI_PORT_PATTERN);
        const port = portMatch ? Number.parseInt(portMatch[1] ?? "", 10) : null;
        let threadId: string | null = directSocketMatch?.[1] ?? null;

        // Fallback: when agentapi runs on a TCP port (kernel didn't support
        // --socket), the socket marker is absent. Use the resolver hook
        // (Hub instance registry) keyed by PID/port.
        if (isAgentapi && !threadId && resolveByPid) {
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
        const isLeak =
          (origin === "managed" && binding === null)
          || origin === "orphan";

        // Token usage: only meaningful for codex/claude. agentapi rows
        // never consume tokens themselves — the codex/claude child does.
        // The shim+native pair both resolve to the same session file via
        // cwd + start-time match, so they correctly show identical totals.
        let tokenUsage: TokenUsage | null = null;
        if (tokenUsageCollector && (agentType === "codex" || agentType === "claude")) {
          try {
            tokenUsage = tokenUsageCollector.lookup(p.pid, agentType);
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
      })
      .sort((a, b) => {
        const order = (e: ProcessSnapshotEntry) =>
          e.is_leak ? 0 : e.origin === "managed" ? 1 : 2;
        const diff = order(a) - order(b);
        if (diff !== 0) return diff;
        return a.pid - b.pid;
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
          tokenUsageCollector.retain(new Set(snapshot.map((e) => e.pid)));
        }
        const managed = snapshot.filter((e) => e.origin === "managed");
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
          managed_leak: managed.filter((e) => e.binding === null).length,
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
      if (!w.thread_id || w.status !== "running") {
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

    const pmResolvers = (lifecycleState as unknown as {
      pm_resolvers?: Array<{ thread_id?: string; worker_id?: string; status?: string; started_at?: string }>;
    }).pm_resolvers ?? [];
    for (const pm of pmResolvers) {
      if (!pm.thread_id || pm.status !== "running") {
        continue;
      }
      index.set(pm.thread_id, {
        dispatcher_role_id: role.threadId,
        worker_id: pm.worker_id ?? "(unknown)",
        role: "pm_resolver",
        status: pm.status,
        started_at: pm.started_at ?? null
      });
    }

    for (const [workerId, w] of Object.entries(lifecycleState.workers)) {
      const validation = (w as unknown as {
        validation?: {
          history?: Array<{ validator_thread_id?: string; status?: string; started_at?: string }>;
        };
      }).validation;
      const history = validation?.history ?? [];
      for (const entry of history) {
        if (!entry.validator_thread_id || entry.status !== "running") {
          continue;
        }
        index.set(entry.validator_thread_id, {
          dispatcher_role_id: role.threadId,
          worker_id: workerId,
          role: "validator",
          status: entry.status,
          started_at: entry.started_at ?? null
        });
      }
    }
  }

  return index;
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
  MERIDIAN_HUB_NODE_PATTERN,
  MERIDIAN_HUB_RELATIVE_NODE_PATTERN,
  isAgentShaped,
  detectAgentType,
  looksLikeMeridianOrphan,
  isReparentedToInit,
  findAgentapiAncestor,
  parseLine,
  summarizeTokenUsage
};
