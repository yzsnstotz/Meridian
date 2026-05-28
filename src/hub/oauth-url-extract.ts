export const CODEX_LOGIN_URL_PATTERNS: RegExp[] = [
  /https:\/\/chatgpt\.com\/auth\/[^\s)>]+/,
  /https:\/\/auth\.openai\.com\/[^\s)>]+/,
  /https:\/\/[a-z0-9.-]+\/oauth\/authorize\?[^\s)>]+/
];

export function extractCodexLoginUrl(line: string): string | null {
  for (const pat of CODEX_LOGIN_URL_PATTERNS) {
    const m = line.match(pat);
    if (m) return m[0];
  }
  return null;
}

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, "");
}

export interface CodexDeviceCode {
  verification_uri: string;
  user_code: string;
}

// Codex emits `https://auth.openai.com/codex/device` as the verification URL
// and a user code like `R0BG-M29HP` (4 alphanumerics, dash, 4-8 alphanumerics
// uppercase). Both must be present before we can surface device-flow state to
// the UI — a half-captured pair is useless.
const CODEX_DEVICE_VERIFICATION_URI_RE = /https:\/\/auth\.openai\.com\/codex\/device\b[^\s)>]*/;
const CODEX_DEVICE_USER_CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4,8})\b/;

export function extractCodexDeviceCode(text: string): CodexDeviceCode | null {
  const clean = stripAnsi(text);
  const urlMatch = clean.match(CODEX_DEVICE_VERIFICATION_URI_RE);
  if (!urlMatch) return null;
  const codeMatch = clean.match(CODEX_DEVICE_USER_CODE_RE);
  if (!codeMatch) return null;
  return { verification_uri: urlMatch[0], user_code: codeMatch[1] };
}
