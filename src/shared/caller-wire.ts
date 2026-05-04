import { z } from "zod";

import { CallerIdentitySchema, HubMessageSchema, type CallerIdentity, type HubMessage } from "../types";

export const CALLER_HTTP_HEADERS = {
  id: "X-Meridian-Caller-Id",
  key: "X-Meridian-Caller-Key",
  version: "X-Meridian-Caller-Version"
} as const;

export const WireAuthSchema = z.object({
  caller_id: z.string().min(1),
  caller_key: z.string().min(1)
});
export type WireAuth = z.infer<typeof WireAuthSchema>;

export const WireFrameSchema = z.object({
  auth: WireAuthSchema,
  message: HubMessageSchema
});
export type WireFrame = z.infer<typeof WireFrameSchema>;

export interface CallerIdentityWithKey extends CallerIdentity {
  caller_id: string;
  caller_key: string;
}

export function wrapHubMessage<TMessage extends HubMessage>(
  message: TMessage,
  identity: CallerIdentityWithKey
): { auth: WireAuth; message: TMessage } {
  if (!identity.caller_id || !identity.caller_key) {
    throw new Error("caller_identity_required");
  }
  const enriched = {
    ...message,
    caller: {
      caller_id: identity.caller_id,
      ...(identity.caller_label !== undefined ? { caller_label: identity.caller_label } : {}),
      ...(identity.caller_version !== undefined ? { caller_version: identity.caller_version } : {})
    }
  } as TMessage;
  return {
    auth: { caller_id: identity.caller_id, caller_key: identity.caller_key },
    message: enriched
  };
}

export interface UnwrappedFrame {
  auth: WireAuth;
  message: HubMessage;
}

export function unwrapWireFrame(payload: unknown): UnwrappedFrame | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (!("auth" in payload) || !("message" in payload)) {
    return null;
  }
  const candidate = payload as { auth?: unknown; message?: unknown };
  const auth = WireAuthSchema.safeParse(candidate.auth);
  if (!auth.success) {
    return null;
  }
  const message = HubMessageSchema.safeParse(candidate.message);
  if (!message.success) {
    return null;
  }
  return { auth: auth.data, message: message.data };
}

export function isWireFrameShape(payload: unknown): boolean {
  return (
    !!payload &&
    typeof payload === "object" &&
    "auth" in (payload as object) &&
    "message" in (payload as object)
  );
}

export function callerEnvelopeFromHttpHeaders(
  headers: Record<string, string | string[] | undefined>
): WireAuth | null {
  const lookup = buildCaseInsensitiveLookup(headers);
  const id = lookup(CALLER_HTTP_HEADERS.id);
  const key = lookup(CALLER_HTTP_HEADERS.key);
  if (!id || !key) {
    return null;
  }
  return { caller_id: id, caller_key: key };
}

export function callerVersionFromHttpHeaders(
  headers: Record<string, string | string[] | undefined>
): string | null {
  const lookup = buildCaseInsensitiveLookup(headers);
  const value = lookup(CALLER_HTTP_HEADERS.version);
  return value ?? null;
}

function buildCaseInsensitiveLookup(
  headers: Record<string, string | string[] | undefined>
): (name: string) => string | null {
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    const flat = Array.isArray(value) ? value[0] : value;
    if (typeof flat !== "string") {
      continue;
    }
    const trimmed = flat.trim();
    if (!trimmed) {
      continue;
    }
    normalized.set(key.toLowerCase(), trimmed);
  }
  return (name) => normalized.get(name.toLowerCase()) ?? null;
}

export const CALLER_REQUIRED_ERROR = "caller_required" as const;
