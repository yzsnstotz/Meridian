/**
 * Meridian HTTP API client used by Meridian-roles dispatcher launchers.
 *
 * After R-01 the public Meridian API boundary covers spawn, run, and kill. Meridian-roles
 * launchers must talk to that boundary instead of executing `meridian-tool` subprocesses
 * (R-03) so the cross-service launch transport is fully owned by Meridian.
 */

import http from "node:http";
import https from "node:https";

import { getCallerIdentity } from "../../shared/caller-identity";

const DEFAULT_MERIDIAN_HTTP = "http://127.0.0.1:3000";
// /api/spawn waits for instanceManager.spawn → agentapi ready → codex/claude
// CLI start → first prompt-readiness probe. Codex startup alone is 20–40s under
// any Hub load; 10s caused frequent false-positive timeouts that ALSO orphaned
// the spawn (Hub kept running, completed the spawn, but the caller had already
// aborted and never bound the thread_id). 60s covers realistic startup with
// margin; ECONNREFUSED still fails instantly via the underlying socket layer.
const SPAWN_REQUEST_TIMEOUT_MS = 60_000;
const KILL_REQUEST_TIMEOUT_MS = 10_000;
const LIST_CREDENTIALS_TIMEOUT_MS = 10_000;
const CALLER_HTTP_HEADERS = {
  id: "X-Meridian-Caller-Id",
  key: "X-Meridian-Caller-Key",
  version: "X-Meridian-Caller-Version"
} as const;

export type MeridianAgentType = "codex" | "claude" | "cursor" | "gemini";

export interface MeridianSpawnRequest {
  /** Provider type forwarded to /api/spawn (codex, claude, cursor, gemini). */
  agentType: string;
  /** "bridge" for persistent thread reservation; "stateless_call" for one-shot Hub-direct exec calls. */
  mode: "bridge" | "stateless_call";
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
  /**
   * Opaque credential identifier resolved against the multi-credential store
   * on the Hub side. When provided, /api/spawn uses this credential set
   * instead of the default (`~/.codex`). Omitted from the wire body when
   * undefined so the Hub keeps its existing default behavior.
   */
  credentialId?: string;
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

/**
 * Summary record returned by Meridian Hub's `GET /api/credentials` endpoint.
 * Mirrors the multi-credential store row visible to the requesting caller.
 * `api_key_metadata` is populated only when `kind === "api_key"`.
 */
export interface MeridianCredentialSummary {
  credential_id: string;
  credential_label: string;
  provider: string;
  kind: "oauth" | "api_key";
  owner_caller_id: string;
  is_default: boolean;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  api_key_metadata: {
    base_url: string;
    model_id: string;
    env_var: string;
  } | null;
}

export interface MeridianApiClient {
  spawn(request: MeridianSpawnRequest): Promise<MeridianSpawnResult>;
  run(request: MeridianRunRequest): Promise<MeridianRunResult>;
  kill(threadId: string): Promise<MeridianKillResult>;
  /**
   * Lists credentials visible to the requesting caller. Used by the
   * role-config GUI to populate the optional `credential_id` selector
   * for codex spawns. Throws on auth failures (401/403) and other
   * non-2xx responses; the GUI surfaces the error inline.
   */
  listCredentials(): Promise<MeridianCredentialSummary[]>;
}

export interface MeridianApiClientOptions {
  /** Override the Meridian HTTP base. Defaults to MERIDIAN_HTTP env or http://127.0.0.1:3000. */
  baseUrl?: string;
  /** Override the bearer token. Defaults to WEB_GUI_TOKEN env or the ?token=... query in MERIDIAN_HTTP. */
  token?: string;
  fetch?: typeof fetch;
}

export function createMeridianApiClient(options: MeridianApiClientOptions = {}): MeridianApiClient {
  return {
    async spawn(request) {
      const body = buildSpawnRequestBody(request);
      const responseBody = await postMeridianJson(options, "/api/spawn", body, {
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
    },
    async listCredentials() {
      const responseBody = await getMeridianJson(options, "/api/credentials", {
        timeoutMs: LIST_CREDENTIALS_TIMEOUT_MS,
        operation: "listCredentials"
      });

      const raw = responseBody.credentials;
      if (!Array.isArray(raw)) {
        throw new MeridianApiError(
          "listCredentials failed: response missing credentials[] array"
        );
      }

      return raw.map((entry, index) => parseCredentialSummary(entry, index));
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
  if (request.credentialId?.trim()) {
    body.credential_id = request.credentialId.trim();
  }

  return body;
}

interface PostOptions {
  timeoutMs: number;
  operation: "spawn" | "run" | "kill";
}

interface GetOptions {
  timeoutMs: number;
  operation: "listCredentials";
}

async function postMeridianJson(
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

  if (!options.fetch) {
    return await postMeridianJsonNative(requestUrl, headers, init.body as string, postOptions);
  }

  let response: Response;
  try {
    response = await options.fetch(requestUrl, init);
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

async function postMeridianJsonNative(
  requestUrl: URL,
  headers: Record<string, string>,
  bodyText: string,
  postOptions: PostOptions
): Promise<Record<string, unknown>> {
  const response = await new Promise<{ statusCode: number; statusMessage: string; body: string }>((resolve, reject) => {
    const transport = requestUrl.protocol === "https:" ? https : http;
    const request = transport.request(
      requestUrl,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-length": String(Buffer.byteLength(bodyText)),
          connection: "close"
        }
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        incoming.on("end", () => {
          resolve({
            statusCode: incoming.statusCode ?? 0,
            statusMessage: incoming.statusMessage ?? "",
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    request.on("error", reject);
    if (postOptions.timeoutMs > 0) {
      request.setTimeout(postOptions.timeoutMs, () => {
        request.destroy(new Error(`${postOptions.operation} request timed out after ${postOptions.timeoutMs}ms`));
      });
    }
    request.end(bodyText);
  }).catch((error) => {
    throw new MeridianApiError(
      `${postOptions.operation} failed: Meridian API unreachable at ${requestUrl.origin}/: ${asErrorMessage(error)}`
    );
  });

  let parsedBody: unknown = null;
  try {
    const text = response.body.trim();
    parsedBody = text ? JSON.parse(text) : null;
  } catch (error) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
      throw new MeridianApiError(
        `${postOptions.operation} failed: invalid JSON response from Meridian: ${asErrorMessage(error)}`,
        response.statusCode
      );
    }
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const errorFromBody = isPlainObject(parsedBody) ? readErrorMessage(parsedBody) : null;
    const fallback = response.statusMessage || `HTTP ${response.statusCode}`;
    throw new MeridianApiError(
      `${postOptions.operation} failed: ${errorFromBody ?? fallback}`,
      response.statusCode
    );
  }

  if (!isPlainObject(parsedBody)) {
    throw new MeridianApiError(
      `${postOptions.operation} failed: unexpected response body shape from Meridian`,
      response.statusCode
    );
  }

  return parsedBody;
}

async function getMeridianJson(
  options: MeridianApiClientOptions,
  pathname: string,
  getOptions: GetOptions
): Promise<Record<string, unknown>> {
  const baseUrl = resolveMeridianHttpBase(options.baseUrl);
  const requestUrl = new URL(pathname, baseUrl);

  const headers: Record<string, string> = {
    accept: "application/json"
  };
  applyCallerHeaders(headers);
  const token = resolveMeridianApiToken(options);
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const init: RequestInit = {
    method: "GET",
    headers
  };
  if (getOptions.timeoutMs > 0) {
    init.signal = AbortSignal.timeout(getOptions.timeoutMs);
  }

  // For GET we always go through fetch (option-provided or global). The native-http
  // fallback used by POST exists primarily for the Hub-spawn path where a custom
  // fetch is rarely injected; GET is only used from the role-config GUI flow which
  // always has the global fetch available.
  const fetchImpl = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(requestUrl, init);
  } catch (error) {
    throw new MeridianApiError(
      `${getOptions.operation} failed: Meridian API unreachable at ${baseUrl}: ${asErrorMessage(error)}`
    );
  }

  let parsedBody: unknown = null;
  try {
    const text = (await response.text()).trim();
    parsedBody = text ? JSON.parse(text) : null;
  } catch (error) {
    if (response.ok) {
      throw new MeridianApiError(
        `${getOptions.operation} failed: invalid JSON response from Meridian: ${asErrorMessage(error)}`,
        response.status
      );
    }
    parsedBody = null;
  }

  if (!response.ok) {
    const errorFromBody = isPlainObject(parsedBody) ? readErrorMessage(parsedBody) : null;
    const fallback = response.statusText || `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      throw new MeridianApiError(
        `${getOptions.operation} failed: authentication failed (${response.status}${
          errorFromBody ? `: ${errorFromBody}` : ""
        })`,
        response.status
      );
    }
    throw new MeridianApiError(
      `${getOptions.operation} failed: ${errorFromBody ?? fallback}`,
      response.status
    );
  }

  if (!isPlainObject(parsedBody)) {
    throw new MeridianApiError(
      `${getOptions.operation} failed: unexpected response body shape from Meridian`,
      response.status
    );
  }

  return parsedBody;
}

function parseCredentialSummary(entry: unknown, index: number): MeridianCredentialSummary {
  if (!isPlainObject(entry)) {
    throw new MeridianApiError(
      `listCredentials failed: credentials[${index}] is not an object`
    );
  }
  const credential_id = readStringField(entry, "credential_id");
  const credential_label = readStringField(entry, "credential_label");
  const provider = readStringField(entry, "provider");
  const kindRaw = entry.kind;
  const owner_caller_id = readStringField(entry, "owner_caller_id");
  const created_at = readStringField(entry, "created_at");

  if (!credential_id) {
    throw new MeridianApiError(`listCredentials failed: credentials[${index}] missing credential_id`);
  }
  if (!credential_label) {
    throw new MeridianApiError(`listCredentials failed: credentials[${index}] missing credential_label`);
  }
  if (!provider) {
    throw new MeridianApiError(`listCredentials failed: credentials[${index}] missing provider`);
  }
  if (kindRaw !== "oauth" && kindRaw !== "api_key") {
    throw new MeridianApiError(
      `listCredentials failed: credentials[${index}] has invalid kind '${String(kindRaw)}'`
    );
  }
  if (!owner_caller_id) {
    throw new MeridianApiError(`listCredentials failed: credentials[${index}] missing owner_caller_id`);
  }
  if (!created_at) {
    throw new MeridianApiError(`listCredentials failed: credentials[${index}] missing created_at`);
  }

  const is_default = entry.is_default === true;
  const last_used_at = typeof entry.last_used_at === "string" && entry.last_used_at.trim().length > 0
    ? entry.last_used_at
    : null;
  const revoked_at = typeof entry.revoked_at === "string" && entry.revoked_at.trim().length > 0
    ? entry.revoked_at
    : null;

  let api_key_metadata: MeridianCredentialSummary["api_key_metadata"] = null;
  if (isPlainObject(entry.api_key_metadata)) {
    const base_url = readStringField(entry.api_key_metadata, "base_url");
    const model_id = readStringField(entry.api_key_metadata, "model_id");
    const env_var = readStringField(entry.api_key_metadata, "env_var");
    if (!base_url || !model_id || !env_var) {
      throw new MeridianApiError(
        `listCredentials failed: credentials[${index}] api_key_metadata missing required fields`
      );
    }
    api_key_metadata = { base_url, model_id, env_var };
  } else if (entry.api_key_metadata !== null && entry.api_key_metadata !== undefined) {
    throw new MeridianApiError(
      `listCredentials failed: credentials[${index}] api_key_metadata must be object or null`
    );
  }

  return {
    credential_id,
    credential_label,
    provider,
    kind: kindRaw,
    owner_caller_id,
    is_default,
    created_at,
    last_used_at,
    revoked_at,
    api_key_metadata
  };
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
