import { describeError } from "@multi-ai-router/core"
import { REDACTED, SECRET_VALUE_PATTERNS } from "./redact-patterns"

/**
 * Redaction is default-on: a log field is scrubbed unless it is demonstrably safe, never the
 * other way round. Credentials, cookies, and OAuth one-shots must not reach a log line at any
 * level — docs/idea/08-observability.md#structured-logging.
 */

export { REDACTED }

/**
 * Both lists below are matched against a *normalized* name — lowercased, with `-` and `_` removed
 * — so one entry covers every spelling a caller might reach for. `api-key`, `api_key`, and
 * `apiKey` are the same field, and a redactor that knows two of the three has a hole in it exactly
 * where a careless call site will put a credential.
 */
function normalizeFieldName(name: string): string {
  return name.toLowerCase().replaceAll(/[-_]/g, "")
}

/** Field names that are always secret, whatever their value looks like. */
const SECRET_FIELD_NAMES = new Set(
  [
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key",
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
  ].map(normalizeFieldName),
)

/**
 * Substrings that make a field name secret wherever they appear.
 *
 * `token` is doing more work than it looks: it is what covers `access_token`, `refresh_token`,
 * `id_token`, `accessToken`, and `anthropic-auth-token` — every OAuth token wire name this router
 * handles — so none of them needs its own entry above, and `redact.test.ts` pins that.
 *
 * There is deliberately no bare `key` marker: `keyId` and `keyName` are bound onto every
 * request logger (`middleware/routerKeyAuth.ts`) and are the only handle an operator has on which
 * router key a line belongs to. `encryption_key` is spelled out instead.
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
].map(normalizeFieldName)

const MAX_DEPTH = 4

/**
 * Ceiling on an `Error` field flattened into a log line. Not an operator knob: it bounds one
 * rendered field the way the scheduler's persisted-error ceiling bounds a column — the policy
 * knob for quoted reasons is `LOG_REASON_MAX_CHARS`, applied where call sites compose messages.
 */
const MAX_ERROR_CHARS = 500

/**
 * Field names repeat on every line (`method`, `path`, `status`, …), and the answer per name never
 * changes, so it is remembered. Bounded because a `Map`'s keys become field names too, and those
 * can come from outside: past the bound a name is simply computed every time.
 */
const MAX_REMEMBERED_FIELD_NAMES = 1_024
const secretFieldNames = new Map<string, boolean>()

export function isSecretFieldName(name: string): boolean {
  const remembered = secretFieldNames.get(name)
  if (remembered !== undefined) return remembered
  const normalized = normalizeFieldName(name)
  const secret =
    SECRET_FIELD_NAMES.has(normalized) ||
    SECRET_FIELD_MARKERS.some((marker) => normalized.includes(marker))
  if (secretFieldNames.size < MAX_REMEMBERED_FIELD_NAMES) secretFieldNames.set(name, secret)
  return secret
}

/**
 * Short values the patterns already found nothing in. The same handful — `POST`, a path, a client
 * build, a host — repeats on every transport line, and each costs ~2 µs of regex work per line on
 * the response path. Only *clean* values are remembered, so the set never holds text that needed
 * scrubbing; it is bounded in count and length, and past the bound a value is simply scanned.
 */
const MAX_REMEMBERED_CLEAN_VALUES = 4_096
const MAX_REMEMBERED_VALUE_CHARS = 256
const cleanValues = new Set<string>()

/** Scrubs secret-looking substrings out of a value that is otherwise safe to log. */
export function redactValue(value: string): string {
  if (cleanValues.has(value)) return value
  let scrubbed = value
  for (const { pattern, replacement } of SECRET_VALUE_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, replacement)
  }
  if (
    scrubbed === value &&
    value.length <= MAX_REMEMBERED_VALUE_CHARS &&
    cleanValues.size < MAX_REMEMBERED_CLEAN_VALUES
  )
    cleanValues.add(value)
  return scrubbed
}

export function redact(
  fields: Record<string, unknown>,
  maxDepth: number = MAX_DEPTH,
): Record<string, unknown> {
  return redactRecord(fields, 0, maxDepth)
}

/**
 * `maxDepth` is a parameter, not always `MAX_DEPTH`, because the same walk scrubs two shapes whose
 * credential-relevant nesting differs: a flat log record is done by 4, but a Sentry event carries
 * its stack at `exception.values[].stacktrace.frames[].vars` — depth 4 lands exactly on
 * `stacktrace` and would redact the whole trace. The Sentry caller passes a deeper floor so the
 * frames survive while their `vars` are still scrubbed; the log caller keeps the default.
 */
function redactRecord(
  fields: Record<string, unknown>,
  depth: number,
  maxDepth: number,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(fields)) {
    safe[name] = isSecretFieldName(name) ? REDACTED : redactUnknown(value, depth + 1, maxDepth)
  }
  return safe
}

/**
 * The three built-ins below keep their payload somewhere `Object.entries` cannot see: an `Error`'s
 * `message` and `stack` are non-enumerable, and a `Map`'s and a `Set`'s contents are not own
 * properties at all. Without a case each, the record walk at the bottom renders all three as `{}`
 * — a log line that is technically safe and completely useless, which is how a redaction bug
 * survives review. Each is unwrapped into a shape the walk understands and scrubbed there.
 */
function redactUnknown(value: unknown, depth: number, maxDepth: number): unknown {
  if (typeof value === "string") return redactValue(value)
  if (value === null || typeof value !== "object") return value
  if (depth >= maxDepth) return REDACTED
  if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry, depth + 1, maxDepth))
  if (value instanceof Date) return value.toISOString()
  // The whole `cause` chain, innermost first, scrubbed like any other free-text value — an error
  // flattened to its outermost message alone institutionalizes wrapper-only logging for every
  // call site that passes the object. Redacted before the cap, so truncation cannot split a
  // credential and leave its tail. The stack is dropped on purpose: it is a file-system map of
  // the host, and the one call site that wants it (`middleware/errorHandler.ts`) passes it as
  // its own field.
  if (value instanceof Error) return redactError(value)
  if (value instanceof Map) return redactRecord(fromMap(value), depth, maxDepth)
  if (value instanceof Set)
    return [...value].map((entry) => redactUnknown(entry, depth + 1, maxDepth))
  return redactRecord(value as Record<string, unknown>, depth, maxDepth)
}

/**
 * An error's whole `cause` chain as one scrubbed, length-capped message — safe to persist in a
 * column or quote into a log line. Redacted before the cap so truncation cannot split a
 * credential and leave its tail in the kept half.
 */
export function describeRedacted(error: unknown): string {
  const scrubbed = redactValue(describeError(error, Number.POSITIVE_INFINITY))
  return scrubbed.length <= MAX_ERROR_CHARS
    ? scrubbed
    : `${scrubbed.slice(0, MAX_ERROR_CHARS - 1)}…`
}

function redactError(error: Error): string {
  return describeRedacted(error)
}

/** Map keys become field names, so a `Map` keyed by header name is scrubbed by name like any record. */
function fromMap(value: ReadonlyMap<unknown, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  for (const [key, entry] of value) record[String(key)] = entry
  return record
}
