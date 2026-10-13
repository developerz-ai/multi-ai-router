/**
 * The boot-path credential scrub. `packages/db`'s migration logger writes to stderr before the
 * server's logger — and its tested redactor in `apps/api/src/logging/redact.ts` — exists, and a
 * connect failure at that moment quotes `DATABASE_URL` back, userinfo included. This is the
 * minimal backstop for that path: connection-string userinfo and self-identifying key material.
 * It is deliberately smaller than the server redactor, which stays authoritative for everything
 * that runs after boot.
 */

const SCRUBBED = "[REDACTED]"

type ScrubPattern = { readonly pattern: RegExp; readonly replacement: string }

const PATTERNS: readonly ScrubPattern[] = [
  // URL userinfo — `postgres://user:pass@host/db` is how DATABASE_URL reaches a boot error.
  // The scheme and host survive: *what* refused the connection is the diagnostic half. The scheme
  // is left out of the match (it stays in the text untouched): matching it made a long `a-a-a-…`
  // run backtrack quadratically. The first branch takes a password holding an unencoded `/`
  // (`postgres://u:p/ss@h`), bounded to 256 characters and stopping at `:` so the scan stays short.
  // Neither its username nor its password crosses `?`, `#`, `&`, `=` or `"`, so it can never cover
  // a `key=` whose secret the key=value pattern below must still see, and it misses a slash
  // password holding one of those (base64 `=` padding just before the `@` excepted). The second is the original pattern unchanged (username-only
  // userinfo, or a password without `/`), so the first only ever adds matches.
  {
    pattern: /:\/\/(?:[^\s/:@?#&="]*:[^\s@"?#:&=]{1,256}={0,2}|[^\s/@]+)@/g,
    replacement: `://${SCRUBBED}@`,
  },
  // Key=value form — DSNs (`password=…`) and env echoes (`ENCRYPTION_KEY=…`) alike.
  {
    pattern:
      /\b((?:password|passwd|pwd|secret|token|api[-_]?key|encryption[-_]?key)\s*=\s*)[^\s&"']+/gi,
    replacement: `$1${SCRUBBED}`,
  },
  // OpenAI/Anthropic-style API keys (`sk-…`, `sk-ant-…`).
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replacement: SCRUBBED },
  // Any JWT — three base64url segments whose header starts `{"`. The header is bounded to 512
  // characters: unbounded, a long `eyJaaaaa-…` run with no dot backtracked quadratically.
  { pattern: /\beyJ[A-Za-z0-9_-]{5,512}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, replacement: SCRUBBED },
  // A header over that bound. Anchored on a non-token character instead of `\b`, so a run starts a
  // scan only once and the cost stays linear; a long-header JWT glued straight after `-`, `_` or a
  // letter is not matched (allowing those makes an `eyJ-eyJ-…` run quadratic again).
  {
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{513,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
    replacement: SCRUBBED,
  },
  // HTTP auth header values quoted into an error.
  { pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, replacement: SCRUBBED },
]

/** Scrubs connection-string userinfo and obvious key material out of free text. */
export function scrubCredentials(text: string): string {
  let scrubbed = text
  for (const { pattern, replacement } of PATTERNS) {
    scrubbed = scrubbed.replace(pattern, replacement)
  }
  return scrubbed
}
