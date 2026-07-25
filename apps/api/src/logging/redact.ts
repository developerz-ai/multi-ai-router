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
  "code",
  "code_verifier",
  "state",
  "prompt",
  "messages",
  "body",
  "completion",
])

/** Substrings that make a field name secret wherever they appear. */
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

/** Values that are self-identifying secrets even under an innocent field name. */
const SECRET_VALUE_PATTERNS = [
  new RegExp(`${ROUTER_KEY_PREFIX}[A-Za-z0-9_-]+`, "g"),
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
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
  for (const pattern of SECRET_VALUE_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, REDACTED)
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
