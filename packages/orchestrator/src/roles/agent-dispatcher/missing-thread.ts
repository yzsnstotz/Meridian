const MISSING_THREAD_PATTERNS = [
  /\bnot registered\b/i,
  /\bunknown thread\b/i,
  /\bnot found\b/i,
  /\bno thread is attached\b/i,
  /\bno registered agent instance\b/i
];

export function isMissingThreadEvidence(message: string | null | undefined): boolean {
  const normalized = message?.trim();
  if (!normalized) {
    return false;
  }

  return MISSING_THREAD_PATTERNS.some((pattern) => pattern.test(normalized));
}

// Hub IPC / A2A transport-class errors. A `kill` (or any Hub request) that
// returns one of these did NOT establish whether the thread actually died on
// the Hub side — the request reached the Hub but the response body did not
// reach us. Distinct from `isMissingThreadEvidence` which implies the Hub
// definitively reported the thread does not exist (kill effectively succeeded
// because the target was already gone). Surfaced 2026-05-19 on
// `agent-dispatcher-98b73906`: the watchdog kept retrying
// `kill failed: Server error: IPC request completed without response body`
// every tick, producing a 315k-entry flood that EPIPE'd the Hub's pino
// transport and degraded /api/system-monitor to a 10s timeout.
const HUB_TRANSPORT_PATTERNS: readonly RegExp[] = [
  /\bIPC request completed without (a |any )?response body\b/i,
  /\bA2A request completed without (a |any )?response body\b/i,
  /\bAttach request completed without (a |any )?response body\b/i,
  /\bServer error\b/i,
  /\bhub may be overloaded\b/i,
  /\bHeaders Timeout\b/i,
  /\bMeridian API unreachable\b/i,
  /\bfetch failed\b/i,
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bEPIPE\b/,
  /\btimed?\s*out\b/i,
  /\bservice unavailable\b/i
];

export function isHubTransportEvidence(message: string | null | undefined): boolean {
  const normalized = message?.trim();
  if (!normalized) {
    return false;
  }

  return HUB_TRANSPORT_PATTERNS.some((pattern) => pattern.test(normalized));
}
