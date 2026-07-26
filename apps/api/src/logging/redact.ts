import { ROUTER_KEY_PREFIX } from "@multi-ai-router/core"

/**
 * Redaction is default-on: a log field is scrubbed unless it is demonstrably safe, never the
 * other way round. Credentials, cookies, and OAuth one-shots must not reach a log line at any
 * level — docs/idea/08-observability.md#structured-logging.
 */

export const REDACTED = "[REDACTED]"

/** Field names that are always secret, whatever their value looks like. */
const SECRET_FIELD_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  // Google's API-key header, and the quota project it is billed against. The project id is not a
  // credential, but it names a tenant, and a log line is the wrong place to learn one.
  "x-goog-api-key",
  "x-goog-user-project",
  "code",
  "code_verifier",
  "state",
  "prompt",
  "messages",
  "body",
  "completion",
])

/**
 * Substrings that make a field name secret wherever they appear.
 *
 * `token` is doing more work than it looks: it is what covers `access_token`, `refresh_token`,
 * `id_token`, `accessToken`, and `anthropic-auth-token` — every OAuth token wire name this router
 * handles — so none of them needs its own entry above, and `redact.test.ts` pins that.
 */
const SECRET_FIELD_MARKERS = [
  "password",
  "secret",
  "token",
  "credential",
  "encryption_key",
  // Catches `codeVerifier`/`code_verifier` however it is spelled — `code_verifier` above only
  // matches the bare snake_case wire name, and the PKCE verifier is exactly as secret camelCased.
  "verifier",
]

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
const SECRET_VALUE_PATTERNS: readonly ValuePattern[] = [
  { pattern: new RegExp(`${ROUTER_KEY_PREFIX}[A-Za-z0-9_-]+`, "g"), replacement: REDACTED },
  // OpenAI and Anthropic API keys (`sk-…`, `sk-ant-…`, `sk-proj-…`).
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replacement: REDACTED },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, replacement: REDACTED },
  // Any JWT — three base64url segments whose header starts `{"`. ChatGPT/Codex access tokens are
  // JWTs, so without this they travel unscrubbed under any field name the `token` marker misses.
  { pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, replacement: REDACTED },
  // URL userinfo — `postgres://user:pass@host/db` is how `DATABASE_URL` reaches a boot error.
  { pattern: /\b([a-z][a-z0-9+.-]*:)\/\/[^\s/:@]+:[^\s/@]+@/gi, replacement: `$1//${REDACTED}@` },
  // A credential passed in a query string, keeping the endpoint and the parameter that carried it.
  // `code`/`code_verifier`/`state` are here because a whole OAuth callback URL logged as one string
  // is not covered by the field-name list — nothing in this router reads a query parameter by those
  // names except that callback, so scrubbing them costs no diagnostic.
  {
    pattern:
      /([?&](?:[a-z0-9_-]*(?:key|token|secret|password)|code(?:[-_]?verifier)?|state)=)[^&\s#"']+/gi,
    replacement: `$1${REDACTED}`,
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
]

const MAX_DEPTH = 4

export function isSecretFieldName(name: string): boolean {
  const lowered = name.toLowerCase()
  if (SECRET_FIELD_NAMES.has(lowered)) return true
  return SECRET_FIELD_MARKERS.some((marker) => lowered.includes(marker))
}

/** Scrubs secret-looking substrings out of a value that is otherwise safe to log. */
export function redactValue(value: string): string {
  let scrubbed = value
  for (const { pattern, replacement } of SECRET_VALUE_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, replacement)
  }
  return scrubbed
}

export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  return redactRecord(fields, 0)
}

function redactRecord(fields: Record<string, unknown>, depth: number): Record<string, unknown> {
  const safe: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(fields)) {
    safe[name] = isSecretFieldName(name) ? REDACTED : redactUnknown(value, depth + 1)
  }
  return safe
}

function redactUnknown(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactValue(value)
  if (value === null || typeof value !== "object") return value
  if (depth >= MAX_DEPTH) return REDACTED
  if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry, depth + 1))
  if (value instanceof Date) return value.toISOString()
  return redactRecord(value as Record<string, unknown>, depth)
}
