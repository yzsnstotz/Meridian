import { randomUUID } from "node:crypto";
import type { HubMessage, ReplyChannel } from "../../types";
import type { MemoryResolver } from "./memory-resolver";
import { SandboxViolationError } from "./memory-resolver";
import type { SessionManager } from "./session-manager";

export interface DispatchCodingJobArgs {
  instruction: string;
  workspace_path?: string;
  taskspec_path?: string;
}

export interface DispatchCodingJobInput {
  args: DispatchCodingJobArgs;
  chatterThreadId: string;
  rolesSocketPath: string;
  resolver: MemoryResolver;
  sessionMgr: SessionManager;
  sendToHub: (msg: HubMessage) => Promise<void>;
  target?: string;
  userReplyChannel?: ReplyChannel;
  rolesServiceId?: string;
}

export interface DispatchCodingJobResult {
  ok: boolean;
  trace_id?: string;
  error?: string;
  transport_stall?: boolean;
}

const TRANSPORT_STALL_PATTERNS: ReadonlyArray<RegExp> = [
  /hub overloaded/i,
  /request timed out/i,
  /fetch failed/i,
  /headers timeout/i,
  /\bECONN/i,
  /\bETIMEDOUT/i
];

export function isTransportStallError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return TRANSPORT_STALL_PATTERNS.some((re) => re.test(msg));
}

const SANDBOX_GATED_PATH_FIELDS: ReadonlyArray<keyof DispatchCodingJobArgs> = [
  "workspace_path",
  "taskspec_path"
];

export async function dispatchCodingJob(input: DispatchCodingJobInput): Promise<DispatchCodingJobResult> {
  for (const field of SANDBOX_GATED_PATH_FIELDS) {
    const value = input.args[field];
    if (value === undefined) continue;
    try {
      input.resolver.resolveAbsoluteUserPath(value as string);
    } catch (e) {
      const reason = e instanceof SandboxViolationError ? e.message : `path validation failed for ${field}`;
      return { ok: false, error: reason };
    }
  }

  const traceId = randomUUID();
  input.sessionMgr.registerTrace({
    trace_id: traceId,
    purpose: "job_dispatch",
    agent_session_id: input.sessionMgr.currentSessionId
  });

  const target = input.target ?? "agent-dispatcher";
  const message: HubMessage = {
    trace_id: traceId,
    thread_id: input.chatterThreadId,
    actor_id: input.rolesServiceId ?? "service:meridian-roles",
    intent: "run",
    target,
    priority: 5,
    payload: {
      content: buildPayloadContent(input.args),
      attachments: []
    },
    mode: "bridge",
    reply_channel: {
      channel: "socket",
      chat_id: input.rolesServiceId ?? "service:meridian-roles",
      socket_path: input.rolesSocketPath
    },
    suppress_reply: false
  };

  try {
    await input.sendToHub(message);
    return { ok: true, trace_id: traceId };
  } catch (e) {
    const stall = isTransportStallError(e);
    if (!stall) {
      input.sessionMgr.clearTrace(traceId);
    }
    return {
      ok: false,
      trace_id: traceId,
      error: e instanceof Error ? e.message : String(e),
      transport_stall: stall
    };
  }
}

function buildPayloadContent(args: DispatchCodingJobArgs): string {
  const lines = [args.instruction.trim()];
  if (args.workspace_path) lines.push(`workspace_path: ${args.workspace_path}`);
  if (args.taskspec_path) lines.push(`taskspec_path: ${args.taskspec_path}`);
  return lines.join("\n");
}
