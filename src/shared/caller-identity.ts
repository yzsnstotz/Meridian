import crypto from "node:crypto";

import type { HubMessage } from "../types";

const DEFAULT_CALLER_ID = "meridian-roles";
const DEFAULT_CALLER_LABEL = "Meridian Roles";

export interface CallerIdentity {
  caller_id: string;
  caller_key: string;
  caller_label: string;
}

interface WireFrame<TMessage extends HubMessage> {
  auth: { caller_id: string; caller_key: string };
  message: TMessage;
}

let cachedIdentity: CallerIdentity | null = null;

// Mirrors Meridian's deriveBuiltinCallerKey contract: HMAC-SHA256 of the
// caller_id keyed by MERIDIAN_INTERNAL_BOOTSTRAP_KEY. Both processes must read
// the same bootstrap secret for verification to succeed on the hub side.
export function deriveBuiltinCallerKey(callerId: string, seed?: string): string {
  const resolvedSeed = seed ?? process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY;
  if (!resolvedSeed) {
    throw new Error("bootstrap_key_missing");
  }
  return crypto.createHmac("sha256", resolvedSeed).update(callerId).digest("hex");
}

export function getCallerIdentity(): CallerIdentity {
  if (cachedIdentity) {
    return cachedIdentity;
  }
  const callerId = process.env.MERIDIAN_ROLES_CALLER_ID?.trim() || DEFAULT_CALLER_ID;
  const callerLabel = process.env.MERIDIAN_ROLES_CALLER_LABEL?.trim() || DEFAULT_CALLER_LABEL;
  cachedIdentity = {
    caller_id: callerId,
    caller_key: deriveBuiltinCallerKey(callerId),
    caller_label: callerLabel
  };
  return cachedIdentity;
}

export function resetCallerIdentityCache(): void {
  cachedIdentity = null;
}

// The hub overwrites message.caller from its registry on success, so we only
// need the auth envelope here. Keep the wrapped message untouched to avoid
// drifting from the local HubMessage shape.
export function wrapForHub<TMessage extends HubMessage>(message: TMessage): WireFrame<TMessage> {
  const identity = getCallerIdentity();
  return {
    auth: {
      caller_id: identity.caller_id,
      caller_key: identity.caller_key
    },
    message
  };
}
