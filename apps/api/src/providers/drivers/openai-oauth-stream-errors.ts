import { isRetryableFailureKind } from "../failure/classify"
import type { FailureClassification, UpstreamFailureKind } from "../types"

/**
 * Classifies a Codex error that arrives **inside** an HTTP 200 Responses stream — a
 * `response.failed` event or a bare `error` event — from its code. Wired from `openai-oauth.ts` as
 * `responseObservation.inspectPayload`, the per-driver hook the response observer prefers over its
 * protocol default (which reads every in-stream error as `server-error`). Pure: no clock, store,
 * logger or network (non-negotiable 9).
 *
 * Two wire shapes carry the error:
 *   - `{type:"response.failed", response:{error:{code, type, message}}}`, and the same nesting
 *     under `error` on an `error` event;
 *   - a flat `{type:"error", code, message}`, the code at the top level.
 *
 * The code decides when there is one. Only when there is no code is the nested error object's
 * `type` read, and only for the limit and deactivated kinds (the HTTP rules' lists; unlike them, a
 * code present always decides). A quota kind needs its code, on a `response.failed` frame: that is
 * the only place the Codex CLI's stream parser reads one (a type-only frame is retried there, a bare
 * `error` event ignored), so neither may park the account here. The flat
 * event's own `type` is never read: it is the event name `error`, not a code.
 *
 * The mapping is a closed list. The driver's HTTP `rules` share the limit, deactivated and quota
 * lists but not the request-shaped one:
 *   - request-shaped codes → `invalid-request` (failover reads `client-error`; no breaker strike);
 *   - the driver's limit codes → `rate-limited`; its deactivated and quota codes →
 *     `credits-exhausted`;
 *   - anything else, or nothing → `server-error`, the behaviour before this hook existed.
 * `signal` is `codex:stream-error:<listed code>` or `codex:stream-error:other`, never an upstream
 * string: it becomes the usage row's `errorClass` and the `error_class` metric label.
 */

export const CODEX_LIMIT_CODES: readonly string[] = ["usage_limit_reached", "rate_limit_exceeded"]
export const CODEX_DEACTIVATED_CODES: readonly string[] = ["account_deactivated"]
/**
 * A spent balance or spend cap. Provenance: openai/codex `codex-rs/codex-api/src/sse/responses_error.rs`
 * (f82e3659, 2026-10-13) maps these four codes to `QuotaExceeded`, which the CLI never retries. That
 * alone does not separate permanent from clock-recoverable (the CLI does not retry a usage limit
 * either); the codes' own meaning does: a balance or a spend cap, as `insufficient_quota` means on
 * OpenAI's API (`openai-api.ts`). A ChatGPT plan's spent window arrives as `usage_limit_reached`
 * instead. No production frame carrying one has been captured. Blast radius: an account reporting
 * one goes `exhausted` until a human acts.
 */
export const CODEX_QUOTA_CODES: readonly string[] = [
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
]

export const CODEX_STREAM_ERROR_REQUEST_CODES: readonly string[] = [
  "invalid_prompt",
  "invalid_request_error",
  "context_length_exceeded",
  "unsupported_parameter",
  "unsupported_value",
  "invalid_json_schema",
]

const KIND_BY_CODE: ReadonlyMap<string, UpstreamFailureKind> = new Map([
  ...CODEX_STREAM_ERROR_REQUEST_CODES.map((code): [string, UpstreamFailureKind] => [
    code,
    "invalid-request",
  ]),
  ...CODEX_LIMIT_CODES.map((code): [string, UpstreamFailureKind] => [code, "rate-limited"]),
  ...[...CODEX_DEACTIVATED_CODES, ...CODEX_QUOTA_CODES].map(
    (code): [string, UpstreamFailureKind] => [code, "credits-exhausted"],
  ),
])

const SIGNAL_PREFIX = "codex:stream-error:"
const QUOTA_CODES: ReadonlySet<string> = new Set(CODEX_QUOTA_CODES)

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Account-level kinds a nested error `type` may name, as the driver's HTTP rules read it. The
 * request-shaped list is never matched against `type`: `invalid_request_error` is OpenAI's catch-all
 * type, carried by account-level refusals such as `invalid_api_key` too.
 */
const TYPE_CODES: ReadonlySet<string> = new Set([...CODEX_LIMIT_CODES, ...CODEX_DEACTIVATED_CODES])

/** The code when there is one; a nested `type` only when there is no code at all. */
function listedCode(
  root: Record<string, unknown> | undefined,
  nested: Record<string, unknown> | undefined,
) {
  const code = text(root?.code) ?? text(nested?.code)
  if (code !== undefined) return KIND_BY_CODE.has(code) ? code : undefined
  const type = text(nested?.type)
  return type !== undefined && TYPE_CODES.has(type) ? type : undefined
}

/**
 * Returns `null` for every frame that is not `response.failed` or `error`, having read only the
 * frame's type. The frame type is `payload.type ?? event`, the precedence the protocol reader uses
 * (`usage/response-terminal.ts`).
 */
export function inspectCodexStreamFrame(
  payload: unknown,
  event: string | undefined,
): FailureClassification | null {
  const root = record(payload)
  // A payload that is not an object is no error frame to the protocol reader either.
  if (root === undefined) return null
  const type = typeof root.type === "string" ? root.type : event
  if (type !== "response.failed" && type !== "error") return null

  const nested = record(root.error) ?? record(record(root.response)?.error)
  const listed = listedCode(root, nested)
  // A quota code counts only on `response.failed`, the one frame the Codex CLI reads it from; a
  // bare `error` event carrying one is ignored there, so here it must not park the account.
  const code =
    listed !== undefined && QUOTA_CODES.has(listed) && type !== "response.failed"
      ? undefined
      : listed
  const kind = code === undefined ? "server-error" : (KIND_BY_CODE.get(code) ?? "server-error")
  const message = text(root.message) ?? text(nested?.message) ?? text(root.error)
  return {
    kind,
    status: 200,
    retryable: isRetryableFailureKind(kind),
    signal: `${SIGNAL_PREFIX}${code ?? "other"}`,
    rateLimit: null,
    ...(message === undefined ? {} : { message }),
  }
}
