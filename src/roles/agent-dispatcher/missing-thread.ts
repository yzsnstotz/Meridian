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
