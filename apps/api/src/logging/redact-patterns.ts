import { ROUTER_KEY_PREFIX } from "@multi-ai-router/core"

/** What a scrubbed value or field reads as. */
export const REDACTED = "[REDACTED]"

type ValuePattern = { readonly pattern: RegExp; readonly replacement: string }

/**
 * Values that are self-identifying secrets even under an innocent field name — the backstop for a
 * credential an upstream quoted back at us, or one a caller stuffed into a field called `note`.
 *
 * Two shapes carry a diagnostic half worth keeping: a connection string's host and a URL's path say
 * *what* the router was talking to, and only the credential inside them is secret. Those entries
 * keep a capture group; every other entry replaces the whole match. A pattern that is unsure
 * redacts — a scrubbed log line costs a debugging session, a leaked one costs a credential.
 */
export const SECRET_VALUE_PATTERNS: readonly ValuePattern[] = [
  // Ambiguous unencoded userinfo: `user:1234?key=1@host` is indistinguishable from
  // a host:port with an @-bearing query. Scrub the whole URL before query redaction
  // can erase the @ evidence. Keeping diagnostics here would expose numeric passwords
  // or non-credential query tails (`user:pw?TAIL@host`).
  //
  // The tail stops at a nested `scheme://` instead of swallowing it. A tail that carries a
  // URL of its own — `postgres://u:p?x=@postgres://v:a"…"@db` — has userinfo of its own, and
  // eating its `://` left the userinfo rule below with no anchor to end on: the nested password
  // reached the log line in the clear, while the previous release's rules had removed it.
  // Stopping at the nested scheme hands that URL to the rules that understand URLs (query
  // first, then userinfo), which scrub its credential and keep its host. The scheme is bounded
  // at 32 characters, so the per-position check stays bounded and the scan stays linear.
  {
    pattern:
      /:\/\/[^\s/:@?]*:[^\s/@?]+\?[^\s/@]*@(?:(?!\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s"'<>])*/gi,
    replacement: `://${REDACTED}`,
  },
  // Discord incoming webhook URLs: the `/webhooks/<id>/<token>` path pair *is* the credential —
  // anyone holding it can post to the channel — and a delivery failure message (fetch error,
  // response snippet, `last_error`, Sentry extra) is exactly where a URL likes to appear. Covers
  // both official hosts, the ptb/canary deployments, any `/api/v<N>/` prefix and the documented
  // query suffixes (`?wait=`, `?thread_id=`). Unlike the URL shapes below, the whole match goes:
  // the path is the secret, so there is no diagnostic half to keep. Ahead of key patterns so a token
  // segment that happens to contain another shape (`sk-…`) is swallowed whole, not nibbled. A
  // trailing sentence period after a query is consumed with it; over-redacting punctuation is
  // the point.
  {
    pattern:
      /\bhttps?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]+(?:[/?#][^\s"'<>]*)?/gi,
    replacement: REDACTED,
  },
  { pattern: new RegExp(`${ROUTER_KEY_PREFIX}[A-Za-z0-9_-]+`, "g"), replacement: REDACTED },
  // OpenAI and Anthropic API keys (`sk-…`, `sk-ant-…`, `sk-proj-…`).
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replacement: REDACTED },
  // The two HTTP auth schemes that put a credential straight into the header value. `Basic` is
  // base64 `user:pass`, so its charset is a subset of `Bearer`'s and one pattern covers both. It
  // will also eat the phrase "Basic authentication", which is the trade this module has already
  // chosen: a scrubbed log line costs a debugging session, a leaked one costs a credential.
  { pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, replacement: REDACTED },
  // Any JWT — three base64url segments whose header starts `{"`. ChatGPT/Codex access tokens are
  // JWTs, so without this they travel unscrubbed under any field name the `token` marker misses.
  // The header segment is bounded to 512 characters (a typical header is well under that): unbounded,
  // a long `eyJaaaaa-…` run with no dot backtracked quadratically.
  { pattern: /\beyJ[A-Za-z0-9_-]{5,512}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, replacement: REDACTED },
  // A header over that bound (a DPoP proof's embedded key, an x5c chain). Anchored on a non-token
  // character instead of `\b`, so a run can start a scan only once and the cost stays linear. The
  // price: a long-header JWT glued straight after `-`, `_` or a letter is not matched; allowing
  // those before it makes an `eyJ-eyJ-…` run quadratic again.
  {
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{513,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
    replacement: REDACTED,
  },
  // A credential passed in a query string, keeping the endpoint and the parameter that carried it.
  // This rule runs BEFORE the URL-userinfo rule below, and it consumes the value whole — the `@`
  // tail included. A query value is a query value, never a URL password: the userinfo rule below
  // does not cross `?` at all, so the two rules claim disjoint text. With the userinfo rule first
  // it read `?user=app&password=p@ssw0rd` as the password of `db.internal:5432` and left the
  // secret after the `@` in the clear. Consuming the query value first is what stops that, and it
  // is what keeps the host and the non-secret parameters of the same URL.
  // The names are the ones the boot-path scrubber takes as well
  // (`packages/core/src/scrub-credentials.ts`): a name ending in `key`/`token`/`secret`/`password`
  // (any prefix — `api_key`, `access_token`), plus `passwd`, `pwd`, `code`, `code_verifier` and
  // `state`. `code`/`code_verifier`/`state` are here because a whole OAuth callback URL logged as
  // one string is not covered by the field-name list — nothing in this router reads a query
  // parameter by those names except that callback, so scrubbing them costs no diagnostic.
  {
    pattern:
      /([?&](?:[a-z0-9_-]*(?:key|token|secret|password|passwd|pwd)|code(?:[-_]?verifier)?|state)=)[^&\s#"']+/gi,
    replacement: `$1${REDACTED}`,
  },
  // URL userinfo — `postgres://user:pass@host/db` is how `DATABASE_URL` reaches a boot error.
  // The scheme is left out of the match (it stays in the text untouched): matching it made a long
  // `a-a-a-…` run backtrack quadratically, and bounding it let a scheme over the bound through.
  // The username may be empty: `redis://:password@cache` carries only a password.
  // A password may hold an unencoded `/` (`postgres://u:p/ss@h`). The first branch allows it, bounded
  // to 256 characters and stopping at `:` so a scan from each `://` stays short and the cost linear.
  // The query-string rule above runs first, so a credential carried in a query value is consumed
  // whole — `@`-tail included — before this rule can read it as a password. Neither branch of this
  // rule crosses `?` any more: a userinfo rule that did would read the query text as the password
  // of the authority, which is how `?user=app&password=p@ssw0rd` used to be taken for the password
  // of `db.internal:5432` — with the secret after the `@` left in the clear. It still misses a
  // slash password holding `?`, `#`, `&`, `=` or `"` (except base64 `=` padding just before the
  // `@`, `Zk3/q+Vb9xQ==@`), and it can still run across a JSON field into an unrelated `@`.
  // Price: `https://host:8080/a@b` loses its host.
  {
    pattern: /:\/\/(?:[^\s/:@?#&="]*:[^\s@"?#:&=]{1,256}={0,2}|[^\s/:@]*:[^\s/@?]+)@/g,
    replacement: `://${REDACTED}@`,
  },
  // Without an @-bearing ambiguous query, a nonnumeric authority component still
  // cannot be a port. Redact it conservatively even when no userinfo terminator remains.
  {
    pattern: /:\/\/[^\s:/?#@]*:(?=[^\s/?#@]*[^\s/?#@0-9])[^\s/?#@]*/g,
    replacement: `://${REDACTED}`,
  },
  // Google API keys: `AIza` + 35 base64url characters.
  { pattern: /\bAIza[0-9A-Za-z_-]{35}/g, replacement: REDACTED },
  // GitHub — classic tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) and fine-grained PATs.
  {
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
    replacement: REDACTED,
  },
  // xAI.
  { pattern: /\bxai-[A-Za-z0-9_-]{16,}/g, replacement: REDACTED },
  // Groq.
  { pattern: /\bgsk_[A-Za-z0-9]{20,}/g, replacement: REDACTED },
  // Cerebras. DeepSeek's keys are `sk-…` and are covered above; Mistral's and Together's carry no
  // prefix at all, so nothing here can recognize one — their field names are what protects them.
  { pattern: /\bcsk-[A-Za-z0-9-]{16,}/g, replacement: REDACTED },
  // OpenCode Console keys: `oc_sk_<id>_<secret>`, with `-` and `_` in the secret.
  { pattern: /\boc_sk_[A-Za-z0-9_-]{16,}/g, replacement: REDACTED }, // A provider's key-management URL names the key by its hash — OpenRouter's "Key limit exceeded …
  // Manage it using https://openrouter.ai/workspaces/default/keys/<64 hex>". The hash identifies the
  // credential, so it is credential material under non-negotiable 3; the path before it stays, it
  // says which provider and workspace refused. 32+ hex so a short numeric id is not swallowed.
  { pattern: /(\/keys\/)[0-9a-f]{32,}(?![0-9a-z])/gi, replacement: `$1${REDACTED}` },
]
