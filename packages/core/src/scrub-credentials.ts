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
  // The scheme and host survive: *what* refused the connection is the diagnostic half.
  { pattern: /\b([a-z][a-z0-9+.-]*):\/\/[^\s/@]+@/gi, replacement: `$1://${SCRUBBED}@` },
  // Key=value form — DSNs (`password=…`) and env echoes (`ENCRYPTION_KEY=…`) alike.
  {
    pattern:
      /\b((?:password|passwd|pwd|secret|token|api[-_]?key|encryption[-_]?key)\s*=\s*)[^\s&"']+/gi,
    replacement: `$1${SCRUBBED}`,
  },
  // OpenAI/Anthropic-style API keys (`sk-…`, `sk-ant-…`).
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replacement: SCRUBBED },
  // Any JWT — three base64url segments whose header starts `{"`.
  { pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, replacement: SCRUBBED },
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
