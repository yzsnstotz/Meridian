/**
 * Service connection utility for Meridian CLI.
 *
 * Public CLI commands talk to Meridian's authenticated HTTP API boundary.
 * They do not probe or use the Hub socket directly.
 */

import http from "node:http";

// Caller-identity HTTP headers (canonical case mandated by the wire contract):
//   X-Meridian-Caller-Id, X-Meridian-Caller-Key, X-Meridian-Caller-Version.
// Definitions live in shared/caller-wire.ts; the import below is the only source.
import { CALLER_HTTP_HEADERS } from "../shared/caller-wire";

const DEFAULT_MERIDIAN_HTTP = "http://localhost:3000";

export interface HubConnection {
  /** Base URL for HTTP requests to Meridian. */
  httpBase: string;
  /** Whether a bearer token was configured for API requests. */
  authenticated: boolean;
  /** Public CLI transport is always the Meridian HTTP API boundary. */
  transport: "http";
}

export interface HubHttpResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface CallerIdentitySetterArgs {
  caller_id: string;
  caller_key: string;
  caller_label: string;
  caller_version?: string;
}

interface ResolvedCallerIdentity {
  caller_id: string;
  caller_key: string;
  caller_label: string;
  caller_version?: string;
}

let activeIdentity: ResolvedCallerIdentity | null = null;

export function setCallerIdentity(args: CallerIdentitySetterArgs): void {
  if (!args.caller_id || !args.caller_key || !args.caller_label) {
    throw new Error("caller_identity_required");
  }
  activeIdentity = {
    caller_id: args.caller_id,
    caller_key: args.caller_key,
    caller_label: args.caller_label,
    ...(args.caller_version ? { caller_version: args.caller_version } : {})
  };
}

export function clearCallerIdentity(): void {
  activeIdentity = null;
}

export function hasCallerIdentity(): boolean {
  return activeIdentity !== null;
}

export async function connectToHub(): Promise<HubConnection> {
  const httpBase = resolveMeridianHttpBase();
  if (await isHttpReachable(httpBase)) {
    return {
      httpBase,
      authenticated: Boolean(resolveMeridianApiToken()),
      transport: "http"
    };
  }

  throw new Error(`Cannot reach Meridian API (${httpBase})`);
}

export async function hubHttpRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<HubHttpResponse> {
  const url = new URL(path, resolveMeridianHttpBase());

  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: buildRequestHeaders(body),
        timeout: 10_000
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => {
          let parsed: unknown = null;
          try {
            parsed = data.trim() ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: parsed
          });
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("HTTP request timed out"));
    });

    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function resolveMeridianHttpBase(): string {
  const raw = process.env.MERIDIAN_HTTP?.trim() || DEFAULT_MERIDIAN_HTTP;
  const url = new URL(raw);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function resolveMeridianApiToken(): string {
  const explicitToken = process.env.WEB_GUI_TOKEN?.trim();
  if (explicitToken) {
    return explicitToken;
  }

  const rawBase = process.env.MERIDIAN_HTTP?.trim();
  if (!rawBase) {
    return "";
  }

  try {
    return new URL(rawBase).searchParams.get("token")?.trim() ?? "";
  } catch {
    return "";
  }
}

function buildRequestHeaders(body?: unknown): http.OutgoingHttpHeaders {
  if (!activeIdentity) {
    throw new Error("caller_identity_not_set");
  }
  const headers: http.OutgoingHttpHeaders = {
    [CALLER_HTTP_HEADERS.id]: activeIdentity.caller_id,
    [CALLER_HTTP_HEADERS.key]: activeIdentity.caller_key
  };
  if (activeIdentity.caller_version) {
    headers[CALLER_HTTP_HEADERS.version] = activeIdentity.caller_version;
  }
  const token = resolveMeridianApiToken();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return headers;
}

function isHttpReachable(baseUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL("/api/health", baseUrl);
    const req = http.request(
      url,
      {
        method: "GET",
        headers: buildRequestHeaders(),
        timeout: 3_000
      },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}
