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
