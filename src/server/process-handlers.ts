import { execFileSync } from "node:child_process";
import * as fsSync from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { LifecycleStore } from "../roles/agent-dispatcher/lifecycle-store";
import type { Logger } from "../roles/base-role";
import type { StateStore } from "../state-store";
import { AgentDispatcherConfigSchema, type DispatchThreadStateV2, type AppState } from "../types";

export interface ProcessHandlersOptions {
  stateStore: Pick<StateStore, "load">;
  log?: Logger;
  // Test seam — defaults to `ps -A -o pid,etime,command`.
  listProcesses?: () => ProcInfo[];
}

export interface ProcInfo {
  pid: number;
  etime: string;
  command: string;
}

interface ProcessSnapshotEntry {
  pid: number;
  etime: string;
  thread_id: string | null;        // parsed from /tmp/agentapi-<id>.sock
  agent_type: string | null;       // codex / claude / ...
  binding: BindingSnapshot | null; // null = leak
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

const AGENTAPI_SOCKET_PATTERN = /\/agentapi-([^/\s]+?)\.sock/;
const AGENTAPI_TYPE_PATTERN = /--type=([a-zA-Z][\w-]*)/;
const AGENTAPI_COMMAND_PATTERN = /agentapi(\s|$|\/bin\/agentapi)/;

export function createProcessHandlers(options: ProcessHandlersOptions): ProcessHandlers {
  const log = options.log ?? console;
  const listProcesses = options.listProcesses ?? defaultListProcesses;

  async function buildSnapshot(): Promise<ProcessSnapshotEntry[]> {
    const procs = listProcesses();
    const agentapi = procs.filter((p) => AGENTAPI_COMMAND_PATTERN.test(p.command));

    // Index every active dispatcher's sidecar by thread_id for O(1) lookup.
    const index = await buildThreadIndex(options.stateStore, log);

    return agentapi
      .map((p) => {
        const socketMatch = p.command.match(AGENTAPI_SOCKET_PATTERN);
        const typeMatch = p.command.match(AGENTAPI_TYPE_PATTERN);
        const threadId = socketMatch?.[1] ?? null;
        const binding = threadId ? (index.get(threadId) ?? null) : null;
        return {
          pid: p.pid,
          etime: p.etime,
          thread_id: threadId,
          agent_type: typeMatch?.[1] ?? null,
          binding,
          command: p.command
        };
      })
      .sort((a, b) => {
        // Leaks first (so they're visually obvious in the GUI), then bound by
        // dispatcher then worker.
        const aLeak = a.binding === null ? 0 : 1;
        const bLeak = b.binding === null ? 0 : 1;
        if (aLeak !== bLeak) {
          return aLeak - bLeak;
        }
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
        const leakCount = snapshot.filter((e) => e.binding === null && e.thread_id !== null).length;
        const unidentifiedCount = snapshot.filter((e) => e.thread_id === null).length;
        writeJson(response, 200, {
          captured_at: new Date().toISOString(),
          total: snapshot.length,
          bound: snapshot.filter((e) => e.binding !== null).length,
          leak: leakCount,
          unidentified: unidentifiedCount,
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

    // Dispatcher controller thread
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

    // Workers
    for (const [workerId, w] of Object.entries(lifecycleState.workers)) {
      if (!w.thread_id) {
        continue;
      }
      // Only bind to threads currently treated as live; otherwise a completed
      // worker's old thread_id would mask a real leak using the same id.
      if (w.status !== "running") {
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

    // PM resolvers (sidecar shape is an array of records)
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

    // Validators (nested in each worker's validation.history)
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
    const output = execFileSync("ps", ["-A", "-o", "pid,etime,command"], {
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
  const match = trimmed.match(/^(\d+)\s+(\S+)\s+(.+)$/);
  if (!match) {
    return null;
  }
  const pid = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(pid)) {
    return null;
  }
  return { pid, etime: match[2] ?? "", command: match[3] ?? "" };
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`${JSON.stringify(body)}\n`);
}

// Exposed for tests
export const _internals = {
  AGENTAPI_SOCKET_PATTERN,
  AGENTAPI_COMMAND_PATTERN,
  parseLine
};
