// Outbound HMAC-signed HTTP transport to ADS.
//
// Why this exists:
//   Project-scoped skills (e.g. `fetch_dna_template`) run inside the chatter
//   role and need to query ADS on behalf of the originating user (read DNA
//   templates, sources, frames the user owns). ADS-side endpoints under
//   `/api/mumu2/*` historically only accepted session cookie / Bearer auth
//   (`requireAuth`), but those are user-owned tokens that the chatter does
//   not — and must not — hold. The agreed contract going forward is the same
//   wire format already used in the reverse direction (ADS → meridian-roles,
//   see `src/web/caller-auth-middleware.ts` + `caller-auth-hmac.ts`):
//
//     POST <ads_base_url>/api/mumu2/<...>
//     headers:
//       x-meridian-caller-id:        <CALLER_ID>            (e.g. "meridian-roles")
//       x-meridian-caller-signature: sha256=<hex(HMAC_SHA256(body))>
//     body: { user_id: "<derived>", ...payload }
//
//   The `user_id` is baked into the BODY — never trusted from a header — so
//   that ADS can attribute the query to a specific user after verifying the
//   service-level HMAC. The HMAC key is a SERVICE secret shared between
//   meridian-roles and ADS (env: MERIDIAN_ROLES_ADS_HMAC_KEY); it identifies
//   the caller process, not the user.
//
//   This module ONLY produces signed requests. ADS-side acceptance of the
//   service-HMAC + body-user_id auth flow on `/api/mumu2/read-only-query`
//   (and friends) is owned by a separate task (the existing ADS handler
//   still uses session-cookie auth as of this commit). The transport
//   landing here unblocks the meridian-roles → ADS direction so the
//   project-scoped skill dispatcher can wire skills end-to-end.

import { createHmac } from "node:crypto";

export const ADS_CALLER_ID_HEADER = "x-meridian-caller-id";
export const ADS_CALLER_SIGNATURE_HEADER = "x-meridian-caller-signature";

/**
 * The minimum response shape downstream skills need to read. Compatible with
 * the global `Response` from `undici` / Node's built-in `fetch`.
 */
export interface AdsTransportResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface AdsHmacTransport {
  /**
   * POSTs JSON to `<baseUrl><path>`. `path` is expected to start with `/`.
   * The `user_id` configured at transport construction time is merged into
   * the request body under the `user_id` key. Throws if the body cannot be
   * serialized as JSON (skills should pass plain objects).
   */
  post(path: string, body: unknown): Promise<AdsTransportResponse>;
}

export interface AdsHmacTransportOptions {
  baseUrl: string;
  callerId: string;
  hmacKey: string;
  userId: string;
  fetchImpl?: typeof fetch;
}

export class AdsHmacTransportConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdsHmacTransportConfigError";
  }
}

/**
 * Construct an HMAC-signing transport bound to a specific user_id.
 *
 * Each call to `post()` re-uses the bound user_id by injecting it into the
 * request body before signing. A separate transport instance MUST be created
 * per user — never share a transport across users (the user_id is the trust
 * boundary, baking it in at construction prevents accidental cross-user
 * data access through a shared transport).
 */
export function createAdsHmacTransport(options: AdsHmacTransportOptions): AdsHmacTransport {
  if (!options.baseUrl) {
    throw new AdsHmacTransportConfigError("baseUrl is required");
  }
  if (!options.callerId) {
    throw new AdsHmacTransportConfigError("callerId is required");
  }
  if (!options.hmacKey) {
    throw new AdsHmacTransportConfigError("hmacKey is required");
  }
  if (!options.userId) {
    throw new AdsHmacTransportConfigError("userId is required");
  }

  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async post(path, body): Promise<AdsTransportResponse> {
      if (!path.startsWith("/")) {
        throw new Error(`ads-hmac transport: path must start with '/': ${path}`);
      }
      const fullUrl = `${baseUrl}${path}`;
      const merged = mergeUserId(body, options.userId);
      const bodyJson = JSON.stringify(merged);
      const signature = signBody(options.hmacKey, bodyJson);

      const response = await fetchImpl(fullUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          [ADS_CALLER_ID_HEADER]: options.callerId,
          [ADS_CALLER_SIGNATURE_HEADER]: `sha256=${signature}`
        },
        body: bodyJson
      });

      // Wrap the global Response so downstream skills don't need to know
      // about `undici` types. Only `.ok`, `.status`, and `.json()` are
      // contractually exposed.
      return {
        ok: response.ok,
        status: response.status,
        async json(): Promise<unknown> {
          return response.json();
        }
      };
    }
  };
}

function mergeUserId(body: unknown, userId: string): Record<string, unknown> {
  if (body === undefined || body === null) {
    return { user_id: userId };
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new Error(
      `ads-hmac transport: body must be a plain object; got ${Array.isArray(body) ? "array" : typeof body}`
    );
  }
  const merged = { ...(body as Record<string, unknown>) };
  // Never let a caller-supplied user_id win over the bound one — that would
  // be a privilege-escalation hole (the bound user_id is the trust anchor).
  merged.user_id = userId;
  return merged;
}

function signBody(key: string, body: string): string {
  return createHmac("sha256", key).update(Buffer.from(body, "utf8")).digest("hex");
}
