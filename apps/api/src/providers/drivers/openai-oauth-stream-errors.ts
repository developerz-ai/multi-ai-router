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
 * The code is matched first, then the nested error object's `type`. The flat event's own `type` is
 * never read: it is the event name `error`, not a code.
 *
 * The mapping is a closed, stream-only list — the driver's HTTP `rules` are untouched:
 *   - request-shaped codes → `invalid-request` (failover reads `client-error`; no breaker strike);
 *   - the driver's limit codes → `rate-limited`; its deactivated code → `credits-exhausted`;
 *   - anything else, or nothing → `server-error`, the behaviour before this hook existed.
 * `signal` is `codex:stream-error:<listed code>` or `codex:stream-error:other`, never an upstream
 * string: it becomes the usage row's `errorClass` and the `error_class` metric label.
 */

export const CODEX_LIMIT_CODES: readonly string[] = ["usage_limit_reached", "rate_limit_exceeded"]
export const CODEX_DEACTIVATED_CODES: readonly string[] = ["account_deactivated"]

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
  ...CODEX_DEACTIVATED_CODES.map((code): [string, UpstreamFailureKind] => [
    code,
    "credits-exhausted",
  ]),
])

const SIGNAL_PREFIX = "codex:stream-error:"

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** The first listed code among the candidates, in the order given. */
function listedCode(candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && KIND_BY_CODE.has(candidate)) return candidate
  }
  return undefined
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
  const type = typeof root?.type === "string" ? root.type : event
  if (type !== "response.failed" && type !== "error") return null

  const nested = record(root?.error) ?? record(record(root?.response)?.error)
  const code = listedCode([root?.code, nested?.code, nested?.type])
  const kind = code === undefined ? "server-error" : (KIND_BY_CODE.get(code) ?? "server-error")
  const message = text(root?.message) ?? text(nested?.message) ?? text(root?.error)
  return {
    kind,
    status: 200,
    retryable: kind !== "invalid-request",
    signal: `${SIGNAL_PREFIX}${code ?? "other"}`,
    rateLimit: null,
    ...(message === undefined ? {} : { message }),
  }
}
