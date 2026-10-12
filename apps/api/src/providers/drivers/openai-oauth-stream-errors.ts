import type { FailureClassification, UpstreamFailureKind } from "../types"

/**
 * Codex stream-error classification for in-stream Responses events on HTTP 200.
 *
 * Sibling of `openai-oauth-quota.ts` / `openai-oauth-models.ts` /
 * `openai-oauth-device.ts` because the parent `openai-oauth.ts` is at the 300-line cap (NN12).
 * Pure: no clock, no store, no logger, no network (NN9). Wired from `openai-oauth.ts` as
 * `responseObservation.inspectPayload` and applied at `createResponseObserver`'s `payload()` step
 * — the same path MiniMax's `inspectMiniMaxSuccess` walks.
 *
 * Two wire shapes carry the error on the Codex Responses surface:
 *
 *   - `response.failed`  — `{type:"response.failed", response:{error:{code, message}}}`
 *   - bare `error` event — `{type:"error", code, message}` at the top level
 *
 * The classification is the `error.code` field. We match `code` first, then the **nested**
 * `response.error.type`; we never read the flat event's `type` (that is the event name
 * `error`, not a code — using it would classify every bare `error` event as `invalid_request_error`
 * because that is the OpenAI `type` convention).
 *
 * Mapping is a closed, stream-only allowlist. The hook is NOT the driver's HTTP `rules` array —
 * that path is unchanged. Listed codes land on:
 *
 *   - `invalid_prompt`, `invalid_request_error`, `context_length_exceeded`, `unsupported_parameter`,
 *     `unsupported_value`, `invalid_json_schema` → `invalid-request` (failover reads `client-error`;
 *     breaker not struck)
 *   - `usage_limit_reached`, `rate_limit_exceeded` → `rate-limited` (first hit trips the breaker;
 *     the observer forces `rateLimit: null` so a stream-only report carries no estimated reset)
 *   - `account_deactivated` → `credits-exhausted` (no clock; permanent `exhausted`)
 *   - any other code, or no code → `server-error` (fail-closed; pinned by AC2)
 *
 * `signal` is a closed vocabulary — `codex:stream-error:<code>` for each listed code,
 * `codex:stream-error:other` for the rest. The message field on the returned classification is
 * sourced from the hook's own reading (never re-parsed at the call site) and is consumed only by
 * the new `relaySuccess` warn line (bounded by `LOG_REASON_MAX_CHARS` after `logging/redact.ts`
 * redaction). It is never written to a usage row.
 *
 * The non-error early return is O(1) — only `frame.type` is read before returning `null`.
 */

/** Closed list of request-shaped in-stream codes. Each yields `invalid-request`. */
export const CODEX_STREAM_ERROR_REQUEST_CODES = [
  "invalid_prompt",
  "invalid_request_error",
  "context_length_exceeded",
  "unsupported_parameter",
  "unsupported_value",
  "invalid_json_schema",
] as const

const CODEX_STREAM_ERROR_LIMIT_CODES = ["usage_limit_reached", "rate_limit_exceeded"] as const
const CODEX_STREAM_ERROR_DEACTIVATED_CODES = ["account_deactivated"] as const

const CODEX_STREAM_ERROR_SIGNAL_PREFIX = "codex:stream-error:"
const CODEX_STREAM_ERROR_OTHER_SIGNAL = `${CODEX_STREAM_ERROR_SIGNAL_PREFIX}other`

const REQUEST_CODE_SET = new Set<string>(CODEX_STREAM_ERROR_REQUEST_CODES)
const LIMIT_CODE_SET = new Set<string>(CODEX_STREAM_ERROR_LIMIT_CODES)
const DEACTIVATED_CODE_SET = new Set<string>(CODEX_STREAM_ERROR_DEACTIVATED_CODES)

function isStreamErrorFrame(event: string | undefined, payload: unknown): boolean {
  // O(1) read of frame.type before any further work. The observer always supplies a parsed
  // payload; the event string is the SSE event: name. We treat `response.failed` and a bare
  // `error` event as the only stream-error shapes — every other frame returns null immediately
  // so the existing protocol-classification path keeps doing the work it already does.
  if (event === "response.failed" || event === "error") return true
  if (typeof payload !== "object" || payload === null) return false
  const type = (payload as { type?: unknown }).type
  return type === "response.failed" || type === "error"
}

function readCode(payload: unknown): string | null {
  // `code` first; for the nested shape, fall back to the `error.code` and the `error.type`.
  // Never read the flat event's `type` (binding note 4).
  if (typeof payload !== "object" || payload === null) return null
  const root = payload as Record<string, unknown>
  const direct = root.code
  if (typeof direct === "string" && direct.length > 0) return direct
  if (typeof direct === "number") return String(direct)
  // `error` may be an object (nested shape) or a string (a quoted body); only the object form
  // carries a `code` field, so the object branch is what reads it. When `error` is absent we
  // fall through to the `response.error` branch for the `response.failed` shape.
  const errorField = root.error
  if (typeof errorField === "object" && errorField !== null) {
    const inner = errorField as Record<string, unknown>
    const innerCode = inner.code
    if (typeof innerCode === "string" && innerCode.length > 0) return innerCode
    if (typeof innerCode === "number") return String(innerCode)
  }
  // Nested `response.error.{code, type}` is read for the `response.failed` shape only.
  const response = root.response
  if (typeof response !== "object" || response === null) return null
  const responseError = (response as Record<string, unknown>).error
  if (typeof responseError !== "object" || responseError === null) return null
  const innerError = responseError as Record<string, unknown>
  const code = innerError.code
  if (typeof code === "string" && code.length > 0) return code
  if (typeof code === "number") return String(code)
  return null
}

function readMessage(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const root = payload as Record<string, unknown>
  const direct = root.message
  if (typeof direct === "string") return direct
  const errorField = root.error
  if (typeof errorField === "string") return errorField
  if (typeof errorField === "object" && errorField !== null) {
    const inner = errorField as Record<string, unknown>
    if (typeof inner.message === "string") return inner.message
  }
  const response = root.response
  if (typeof response !== "object" || response === null) return undefined
  const responseError = (response as Record<string, unknown>).error
  if (typeof responseError !== "object" || responseError === null) return undefined
  const innerError = responseError as Record<string, unknown>
  if (typeof innerError.message === "string") return innerError.message
  return undefined
}

function classifyCodexStreamError(code: string | null): {
  readonly kind: UpstreamFailureKind
  readonly signal: string
  readonly retryable: boolean
} {
  if (code !== null) {
    if (REQUEST_CODE_SET.has(code)) {
      return {
        kind: "invalid-request",
        signal: `${CODEX_STREAM_ERROR_SIGNAL_PREFIX}${code}`,
        retryable: false,
      }
    }
    if (LIMIT_CODE_SET.has(code)) {
      return {
        kind: "rate-limited",
        signal: `${CODEX_STREAM_ERROR_SIGNAL_PREFIX}${code}`,
        retryable: true,
      }
    }
    if (DEACTIVATED_CODE_SET.has(code)) {
      return {
        kind: "credits-exhausted",
        signal: `${CODEX_STREAM_ERROR_SIGNAL_PREFIX}${code}`,
        retryable: true,
      }
    }
  }
  return { kind: "server-error", signal: CODEX_STREAM_ERROR_OTHER_SIGNAL, retryable: true }
}

/**
 * Codex in-stream frame classifier. Returns `null` for any frame that is not a
 * `response.failed` or bare `error` event. Otherwise returns a `FailureClassification` whose
 * `signal` is `codex:stream-error:<listed code>` or `codex:stream-error:other`.
 */
export function inspectCodexStreamFrame(
  payload: unknown,
  event: string | undefined,
): FailureClassification | null {
  if (!isStreamErrorFrame(event, payload)) return null
  const code = readCode(payload)
  const message = readMessage(payload)
  const { kind, signal, retryable } = classifyCodexStreamError(code)
  const classification: MutableFailureClassification = {
    kind,
    status: 200,
    retryable,
    signal,
    rateLimit: null,
  }
  if (message !== undefined) classification.message = message
  return Object.freeze(classification) as FailureClassification
}

interface MutableFailureClassification {
  kind: UpstreamFailureKind
  status: number
  retryable: boolean
  signal: string
  rateLimit: null
  message?: string
}
