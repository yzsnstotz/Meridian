/**
 * Meridian HTTP API client used by Meridian-roles dispatcher launchers.
 *
 * After R-01 the public Meridian API boundary covers spawn, run, and kill. Meridian-roles
 * launchers must talk to that boundary instead of executing `meridian-tool` subprocesses
 * (R-03) so the cross-service launch transport is fully owned by Meridian.
 */

import { getCallerIdentity } from "../../shared/caller-identity";

const DEFAULT_MERIDIAN_HTTP = "http://127.0.0.1:3000";
const SPAWN_REQUEST_TIMEOUT_MS = 10_000;
const KILL_REQUEST_TIMEOUT_MS = 10_000;
const CALLER_HTTP_HEADERS = {
  id: "X-Meridian-Caller-Id",
  key: "X-Meridian-Caller-Key",
  version: "X-Meridian-Caller-Version"
} as const;

export type MeridianAgentType = "codex" | "claude" | "cursor" | "gemini";

export interface MeridianSpawnRequest {
  /** Provider type forwarded to /api/spawn (codex, claude, cursor, gemini). */
  agentType: string;
  /** "bridge" for stateful Hub sessions, "pane_bridge" for visible workers, "stateless_call" for read-only Codex calls. */
  mode: "bridge" | "pane_bridge" | "stateless_call";
  /** Absolute working directory for the spawned thread. Validated under AGENT_WORKDIR by Meridian. */
  spawnDir: string;
  /** Optional model identifier forwarded to the provider adapter. */
  modelId?: string;
  /** Optional reasoning effort level (low, medium, high, xhigh). Sent separately from model_id. */
  effort?: string;
  /** Approval policy. Meridian maps this to provider-specific flags. */
  autoApprove?: boolean;
  /** Optional sandbox mode. Stateless Codex validator calls use read-only. */
  sandboxMode?: "read-only" | "workspace-write";
}

export interface MeridianSpawnResult {
  threadId: string;
  source?: string;
}

export interface MeridianRunRequest {
  threadId: string;
  /** Prompt or command body forwarded to the agent thread. */
  content: string;
  attachments?: unknown[];
}

export interface MeridianRunResult {
  threadId: string;
  status: string;
  runState?: string;
  content?: string;
  raw: Record<string, unknown>;
}

export interface MeridianKillResult {
  threadId: string;
  status: string;
  raw: Record<string, unknown>;
}

export interface MeridianApiClient {
  spawn(request: MeridianSpawnRequest): Promise<MeridianSpawnResult>;
  run(request: MeridianRunRequest): Promise<MeridianRunResult>;
  kill(threadId: string): Promise<MeridianKillResult>;
}

export interface MeridianApiClientOptions {
  /** Override the Meridian HTTP base. Defaults to MERIDIAN_HTTP env or http://127.0.0.1:3000. */
  baseUrl?: string;
  /** Override the bearer token. Defaults to WEB_GUI_TOKEN env or the ?token=... query in MERIDIAN_HTTP. */
  token?: string;
  fetch?: typeof fetch;
}

export function createMeridianApiClient(options: MeridianApiClientOptions = {}): MeridianApiClient {
  const httpFetch = options.fetch ?? fetch;

  return {
    async spawn(request) {
      const body = buildSpawnRequestBody(request);
      const responseBody = await postMeridianJson(httpFetch, options, "/api/spawn", body, {
        timeoutMs: SPAWN_REQUEST_TIMEOUT_MS,
        operation: "spawn"
      });

      const errorMessage = readErrorMessage(responseBody);
      if (errorMessage) {
        throw new MeridianApiError(`spawn failed: ${errorMessage}`);
      }

      const threadId = readThreadId(responseBody);
      if (!threadId) {
        throw new MeridianApiError("Failed to parse spawn response");
      }

      return {
        threadId,
        source: readStringField(responseBody, "source")
      };
    },
    async run(request) {
      const trimmedThreadId = request.threadId?.trim();
      if (!trimmedThreadId) {
        throw new MeridianApiError("run failed: thread_id is required");
      }
      if (!request.content || !request.content.trim()) {
        throw new MeridianApiError("run failed: content is required");
      }

      const responseBody = await postMeridianJson(
        httpFetch,
        options,
        "/api/run",
        {
          thread_id: trimmedThreadId,
          content: request.content,
          attachments: request.attachments ?? []
        },
        {
          // /api/run waits for the Hub result, which can be long-running for worker threads.
          // The launcher fires this without awaiting completion; Meridian owns the lifetime.
          timeoutMs: 0,
          operation: "run"
        }
      );

      const errorMessage = readErrorMessage(responseBody);
      if (errorMessage) {
        throw new MeridianApiError(`run failed: ${errorMessage}`);
      }

      const status = readStringField(responseBody, "status") ?? "";
      const runState = readStringField(responseBody, "run_state");
      const content = readStringField(responseBody, "content");
      const threadIdResult = readThreadId(responseBody) ?? trimmedThreadId;

      return {
        threadId: threadIdResult,
        status,
        runState,
        content,
        raw: responseBody
      };
    },
    async kill(threadId) {
      const trimmed = threadId?.trim();
      if (!trimmed) {
        throw new MeridianApiError("kill failed: thread_id is required");
      }

      const responseBody = await postMeridianJson(
        httpFetch,
        options,
        "/api/kill",
        { thread_id: trimmed },
        {
          timeoutMs: KILL_REQUEST_TIMEOUT_MS,
          operation: "kill"
        }
      );

      const errorMessage = readErrorMessage(responseBody);
      if (errorMessage) {
        throw new MeridianApiError(`kill failed: ${errorMessage}`);
      }

      return {
        threadId: readThreadId(responseBody) ?? trimmed,
        status: readStringField(responseBody, "status") ?? "",
        raw: responseBody
      };
    }
  };
}

export class MeridianApiError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = "MeridianApiError";
  }
}

function buildSpawnRequestBody(request: MeridianSpawnRequest): Record<string, unknown> {
  const trimmedAgentType = request.agentType?.trim();
  if (!trimmedAgentType) {
    throw new MeridianApiError("spawn failed: agent_type is required");
  }
  const trimmedSpawnDir = request.spawnDir?.trim();
  if (!trimmedSpawnDir) {
    throw new MeridianApiError("spawn failed: spawn_dir is required");
  }

  const body: Record<string, unknown> = {
    type: trimmedAgentType,
    provider: trimmedAgentType,
    mode: request.mode,
    spawn_dir: trimmedSpawnDir
  };

  if (typeof request.autoApprove === "boolean") {
    body.auto_approve = request.autoApprove;
  }
  if (request.modelId?.trim()) {
    body.model_id = request.modelId.trim();
  }
  if (request.effort?.trim()) {
    body.effort = request.effort.trim();
  }
  if (request.sandboxMode?.trim()) {
    body.sandbox_mode = request.sandboxMode.trim();
  }

  return body;
}

interface PostOptions {
  timeoutMs: number;
  operation: "spawn" | "run" | "kill";
}

async function postMeridianJson(
  httpFetch: typeof fetch,
  options: MeridianApiClientOptions,
  pathname: string,
  body: unknown,
  postOptions: PostOptions
): Promise<Record<string, unknown>> {
  const baseUrl = resolveMeridianHttpBase(options.baseUrl);
  const requestUrl = new URL(pathname, baseUrl);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json"
  };
  applyCallerHeaders(headers);
  const token = resolveMeridianApiToken(options);
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  };
  if (postOptions.timeoutMs > 0) {
    init.signal = AbortSignal.timeout(postOptions.timeoutMs);
  }

  let response: Response;
  try {
    response = await httpFetch(requestUrl, init);
  } catch (error) {
    throw new MeridianApiError(
      `${postOptions.operation} failed: Meridian API unreachable at ${baseUrl}: ${asErrorMessage(error)}`
    );
  }

  let parsedBody: unknown = null;
  try {
    const text = (await response.text()).trim();
    parsedBody = text ? JSON.parse(text) : null;
  } catch (error) {
    if (response.ok) {
      throw new MeridianApiError(
        `${postOptions.operation} failed: invalid JSON response from Meridian: ${asErrorMessage(error)}`,
        response.status
      );
    }
    parsedBody = null;
  }

  if (!response.ok) {
    const errorFromBody = isPlainObject(parsedBody) ? readErrorMessage(parsedBody) : null;
    const fallback = response.statusText || `HTTP ${response.status}`;
    throw new MeridianApiError(
      `${postOptions.operation} failed: ${errorFromBody ?? fallback}`,
      response.status
    );
  }

  if (!isPlainObject(parsedBody)) {
    throw new MeridianApiError(
      `${postOptions.operation} failed: unexpected response body shape from Meridian`,
      response.status
    );
  }

  return parsedBody;
}

function applyCallerHeaders(headers: Record<string, string>): void {
  const identity = getCallerIdentity();
  headers[CALLER_HTTP_HEADERS.id] = identity.caller_id;
  headers[CALLER_HTTP_HEADERS.key] = identity.caller_key;
  headers[CALLER_HTTP_HEADERS.version] = identity.caller_id;
}

function resolveMeridianHttpBase(override: string | undefined): string {
  const candidate = override?.trim() || process.env.MERIDIAN_HTTP?.trim() || DEFAULT_MERIDIAN_HTTP;
  const url = new URL(candidate);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function resolveMeridianApiToken(options: MeridianApiClientOptions): string | null {
  const explicit = options.token?.trim();
  if (explicit) {
    return explicit;
  }
  const fromEnv = process.env.WEB_GUI_TOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const rawBase = process.env.MERIDIAN_HTTP?.trim();
  if (!rawBase) {
    return null;
  }
  try {
    const queryToken = new URL(rawBase).searchParams.get("token")?.trim();
    return queryToken && queryToken.length > 0 ? queryToken : null;
  } catch {
    return null;
  }
}

function readErrorMessage(body: Record<string, unknown> | null | undefined): string | null {
  if (!body) {
    return null;
  }
  if (body.ok === false && typeof body.error === "string" && body.error.trim().length > 0) {
    return body.error.trim();
  }
  if (typeof body.error === "string" && body.error.trim().length > 0) {
    return body.error.trim();
  }
  if (body.status === "error") {
    if (typeof body.content === "string" && body.content.trim().length > 0) {
      return body.content.trim();
    }
    return "Meridian returned status=error without a message";
  }
  return null;
}

function readThreadId(body: Record<string, unknown> | null | undefined): string | null {
  if (!body) {
    return null;
  }
  const direct = readStringField(body, "thread_id");
  if (direct) {
    return direct;
  }
  if (isPlainObject(body.data)) {
    const nested = readStringField(body.data, "thread_id");
    if (nested) {
      return nested;
    }
  }
  return null;
}

function readStringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Node.js native fetch wraps connection errors (ECONNREFUSED, ETIMEDOUT, etc.)
    // inside a TypeError("fetch failed") with the real error in `.cause`. Extract the
    // underlying message so callers can pattern-match on the actual failure reason.
    const cause = (error as { cause?: unknown }).cause;
    if (error.message === "fetch failed" && cause instanceof Error && cause.message) {
      return `fetch failed (${cause.message})`;
    }
    return error.message;
  }
  return String(error);
}
