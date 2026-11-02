/**
 * The boot-path credential scrub. `packages/db`'s migration logger writes to stderr before the
 * server's logger — and its tested redactor in `apps/api/src/logging/redact.ts` — exists, and a
 * connect failure at that moment quotes `DATABASE_URL` back, userinfo included. This is the
 * minimal backstop for that path: connection-string userinfo, query-string credentials, and
 * self-identifying key material. It is deliberately smaller than the server redactor, which stays
 * authoritative for everything that runs after boot — except that the two take the *same*
 * query-string parameter names, so a value the boot path scrubs is not one the server redactor
 * exposes.
 */

const SCRUBBED = "[REDACTED]"

type ScrubPattern = { readonly pattern: RegExp; readonly replacement: string }

const PATTERNS: readonly ScrubPattern[] = [
  // Ambiguous unencoded userinfo: `user:1234?key=1@host` is indistinguishable from
  // a host:port with an @-bearing query. Scrub the whole URL before query redaction
  // can erase the @ evidence. Keeping diagnostics here would expose numeric passwords
  // or non-credential query tails (`user:pw?TAIL@host`).
  //
  // The tail stops at a nested `scheme://` instead of swallowing it, exactly as the server
  // redactor's guard does (`apps/api/src/logging/redact.ts`): a tail that carries a URL of
  // its own has userinfo of its own, and eating its `://` left the userinfo rule below with
  // no anchor to end on, so the nested password reached the boot log in the clear. Stopping
  // at the nested scheme hands that URL to the query and userinfo rules below. The scheme is
  // bounded at 32 characters, so the per-position check stays bounded and the scan stays linear.
  {
    pattern:
      /:\/\/[^\s/:@?]*:[^\s/@?]+\?[^\s/@]*@(?:(?!\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s"'<>])*/gi,
    replacement: `://${SCRUBBED}`,
  },
  // A credential passed in a query string, keeping the endpoint and the parameter that carried it.
  // This rule runs BEFORE the URL-userinfo rule below, and it consumes the value whole — the `@`
  // tail included. A query value is a query value, never a URL password: the userinfo rule below
  // does not cross `?` at all, so the two rules claim disjoint text. With the userinfo rule first
  // it read `?user=app&password=p@ssw0rd` as the password of `db.internal:5432` and left the
  // secret after the `@` in the clear.
  // The names are the ones the server redactor takes (`apps/api/src/logging/redact.ts`): a name
  // ending in `key`/`token`/`secret`/`password` (any prefix — `api_key`, `access_token`), plus
  // `passwd`, `pwd`, `code`, `code_verifier` and `state`. The two redactors take the same names, so
  // what one scrubs the other cannot expose.
  // The unanchored key=value rule further down stays where it is: it is the DSN/env form
  // (`host=db password=…`), and running it ahead of the userinfo rule would cost the host on
  // `postgres://u:secret=1@db`.
  {
    pattern:
      /([?&](?:[a-z0-9_-]*(?:key|token|secret|password|passwd|pwd)|code(?:[-_]?verifier)?|state)=)[^&\s#"']+/gi,
    replacement: `$1${SCRUBBED}`,
  },
  // URL userinfo — `postgres://user:pass@host/db` is how DATABASE_URL reaches a boot error.
  // The scheme and host survive: *what* refused the connection is the diagnostic half. The scheme
  // is left out of the match (it stays in the text untouched): matching it made a long `a-a-a-…`
  // run backtrack quadratically. A lookbehind still requires the scheme main's pattern required
  // (a letter at a word boundary, then scheme characters), so text with no real scheme before `://`
  // is left to the key=value pattern; it scans back only to the previous non-scheme character, so
  // it stays linear. The first branch takes a password holding an unencoded `/`
  // (`postgres://u:p/ss@h`), bounded to 256 characters and stopping at `:` so the scan stays short.
  // The query-string rule above runs first, so a credential carried in a query value is consumed
  // whole — `@`-tail included — before this rule can read it as a password. Neither branch crosses
  // `?` any more: a userinfo rule that did would read the query text as the password of the
  // authority, which is how `?user=app&password=p@ssw0rd` used to be taken for the password of
  // `db.internal:5432` — with the secret after the `@` left in the clear. The first branch's
  // username and password cross neither `?`, `#`, `&`, `=` nor `"`, so it misses a slash password
  // holding one of those; the second branch now stops at `?` as well, which is exactly why the
  // query rule has to come first. One exception: up to two `=` of base64 padding just before the
  // `@`, allowed only when no key name of the key=value pattern sits right before them, so it
  // never covers a `key=` whose secret that pattern (anchored on `\b`, not `?` or `&`) must still
  // see: `;password=@x` stays that pattern's. The second branch is the original pattern with the
  // `?` taken out of its password class (username-only userinfo, or a password without `/`), so
  // the two rules now claim disjoint text.
  {
    pattern:
      /(?<=\b[a-z][a-z0-9+.-]*):\/\/(?:[^\s/:@?#&="]*:[^\s@"?#:&=]{1,256}(?:(?<!\b(?:password|passwd|pwd|secret|token|api[-_]?key|encryption[-_]?key))={1,2})?|[^\s/@?]+)@/gi,
    replacement: `://${SCRUBBED}@`,
  },
  // Key=value form — DSNs (`password=…`) and env echoes (`ENCRYPTION_KEY=…`) alike.
  {
    pattern:
      /\b((?:password|passwd|pwd|secret|token|api[-_]?key|encryption[-_]?key)\s*=\s*)[^\s&"']+/gi,
    replacement: `$1${SCRUBBED}`,
  },
  // Without an @-bearing ambiguous query, a nonnumeric authority component still
  // cannot be a port. Redact it conservatively even when no userinfo terminator remains.
  {
    pattern: /:\/\/[^\s:/?#@]*:(?=[^\s/?#@]*[^\s/?#@0-9])[^\s/?#@]*/g,
    replacement: `://${SCRUBBED}`,
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
