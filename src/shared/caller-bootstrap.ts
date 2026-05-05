import crypto from "node:crypto";

export function deriveBuiltinCallerKey(callerId: string): string {
  const seed = process.env.MERIDIAN_INTERNAL_BOOTSTRAP_KEY;
  if (!seed) throw new Error("bootstrap_key_missing");
  return crypto.createHmac("sha256", seed).update(callerId).digest("hex");
}

export const BUILTIN_CALLERS = [
  { caller_id: "meridian-web",       caller_label: "Meridian Web" },
  { caller_id: "meridian-cli",       caller_label: "Meridian CLI" },
  { caller_id: "meridian-telegram",  caller_label: "Meridian Telegram" },
  { caller_id: "meridian-monitor",   caller_label: "Meridian Monitor" },
  { caller_id: "meridian-roles",     caller_label: "Meridian-Roles" },
  { caller_id: "meridian-admin",     caller_label: "Meridian Admin" }
] as const;
