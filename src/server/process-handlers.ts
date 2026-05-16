import { execFileSync } from "node:child_process";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { LifecycleStore } from "../roles/agent-dispatcher/lifecycle-store";
import type { Logger } from "../roles/base-role";
import type { StateStore } from "../state-store";
import { AgentDispatcherConfigSchema, type DispatchThreadStateV2, type AppState } from "../types";

export interface ProcessHandlersOptions {
  stateStore: Pick<StateStore, "load">;
  log?: Logger;
  // Test seam — defaults to `ps -A -o pid,ppid,etime,command`.
  listProcesses?: () => ProcInfo[];
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
const AGENTAPI_TYPE_PATTERN = /--type=([a-zA-Z][\w-]*)/;
// `agentapi server` parent (real or symlinked binary path)
const AGENTAPI_COMMAND_PATTERN = /(?:^|[\s/])agentapi\s+server(?:\s|$)/;
// Codex CLI — bare `codex `, native binary path `.../codex/codex` or `.../codex`,
// or node-wrapped `node .../codex`. Matches the executable name after start, a
// path separator, or whitespace.
const CODEX_COMMAND_PATTERN = /(?:^|[\s/])codex(?:\s|$)/;
// Claude CLI — `claude --flag` or path-prefixed `.../claude --flag`.
const CLAUDE_COMMAND_PATTERN = /(?:^|[\s/])claude(?:\s|$)/;

export function createProcessHandlers(options: ProcessHandlersOptions): ProcessHandlers {
  const log = options.log ?? console;
  const listProcesses = options.listProcesses ?? defaultListProcesses;

  async function buildSnapshot(): Promise<ProcessSnapshotEntry[]> {
    const procs = listProcesses();
    const byPid = new Map<number, ProcInfo>();
    for (const p of procs) {
      byPid.set(p.pid, p);
    }

    // Pre-classify every process so we can detect agentapi ancestors.
    const agentapiPids = new Set<number>();
    for (const p of procs) {
      if (AGENTAPI_COMMAND_PATTERN.test(p.command)) {
        agentapiPids.add(p.pid);
      }
    }

    const candidates = procs.filter((p) => isAgentShaped(p.command));

    const index = await buildThreadIndex(options.stateStore, log);

    return candidates
      .map((p) => {
        const agentType = detectAgentType(p.command);
        const isAgentapi = agentType === "agentapi";
        const directSocketMatch = p.command.match(AGENTAPI_SOCKET_PATTERN);
        let threadId: string | null = directSocketMatch?.[1] ?? null;

        // Walk the PPID chain to find an agentapi ancestor (codex/claude CLI
        // is the agentapi *child*; the parent argv carries the socket marker).
        let ancestorAgentapi: ProcInfo | null = null;
        if (!isAgentapi) {
          ancestorAgentapi = findAgentapiAncestor(p, byPid, agentapiPids);
          if (ancestorAgentapi) {
            const ancestorSocket = ancestorAgentapi.command.match(AGENTAPI_SOCKET_PATTERN);
            if (ancestorSocket && !threadId) {
              threadId = ancestorSocket[1];
            }
          }
        }

        const origin: ProcessOrigin =
          isAgentapi || ancestorAgentapi
            ? "managed"
            : (!isAgentapi && (agentType === "codex" || agentType === "claude")
                && looksLikeMeridianOrphan(p.command))
              ? "orphan"
              : "external";

        const binding = threadId ? (index.get(threadId) ?? null) : null;
        const isLeak =
          (origin === "managed" && threadId !== null && binding === null)
          || origin === "orphan";

        return {
          pid: p.pid,
          ppid: p.ppid,
          etime: p.etime,
          agent_type: agentType,
          thread_id: threadId,
          origin,
          binding,
          is_leak: isLeak,
          command: p.command
        };
      })
      .sort((a, b) => {
        // Leaks first, then managed, then external. Within each bucket, oldest
        // (longer etime) first so long-running surprises stand out.
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
        const managed = snapshot.filter((e) => e.origin === "managed");
        const external = snapshot.filter((e) => e.origin === "external");
        const orphan = snapshot.filter((e) => e.origin === "orphan");
        const leak = snapshot.filter((e) => e.is_leak).length;
        writeJson(response, 200, {
          captured_at: new Date().toISOString(),
          total: snapshot.length,
          managed_bound: managed.filter((e) => e.binding !== null).length,
          managed_leak: managed.filter((e) => e.binding === null).length,
          orphan: orphan.length,
          external: external.length,
          leak,
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
  isAgentShaped,
  detectAgentType,
  looksLikeMeridianOrphan,
  findAgentapiAncestor,
  parseLine
};
