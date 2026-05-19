/**
 * Sanitize credential filesystem paths out of error messages before they are
 * sent over the wire. Caller IDs, OAuth UUIDs, and home directories should not
 * leak via raw `err.message` text from fs errors.
 *
 * Rules:
 *  - Any absolute path that contains a `credentials/<segment>` sub-path is
 *    collapsed to the literal `<credentials-dir>`. The `<segment>` after
 *    `credentials/` is preserved as a UUID-shaped sub-segment ONLY when it
 *    cannot identify a user (currently we strip the whole tail).
 *  - The `.meridian/credentials/...` variant gets the same treatment regardless
 *    of the prefix (Users home, /tmp, /var/folders, /private/var/...).
 *
 * Implementation: a single regex pass over the input. Keeps non-path text
 * (error codes, syscall names) intact.
 */

// Matches a path-like token ending in a `credentials/<uuid-or-anything>/<file>`
// fragment, then optionally extends through subsequent path characters. This
// captures things like:
//   /Users/foo/.meridian/credentials/abc/env.json
//   /tmp/T/cred-test/.meridian/credentials/xyz/config.toml
//   /var/folders/.../T/meridian-creds-1/credentials/uuid-12345/auth.json
//   /private/var/folders/.../credentials/UUID/env.json.tmp
//
// The leading boundary uses a quote, whitespace, or string-start; the trailing
// boundary stops at quote/whitespace/end. We intentionally do NOT require a
// `.meridian/` prefix because tests use `meridian-creds-N/credentials/...`
// paths under `/var/folders/.../T/`.
const CREDENTIALS_PATH_RE =
  /(?:\/[^\s'"<>]*?)?\/credentials\/[^\s'"<>]+/g;

export function sanitizeErrorMessage(message: string): string {
  if (!message) return message;
  return message.replace(CREDENTIALS_PATH_RE, "<credentials-dir>");
}
