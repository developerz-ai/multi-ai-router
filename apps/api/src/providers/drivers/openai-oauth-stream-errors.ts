import { isRetryableFailureKind } from "../failure/classify"
import type {
  FailureClassification,
  ResponseObservationDescriptor,
  UpstreamFailureKind,
} from "../types"

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
 * The code decides when there is one, with one exception below: a quota code at
 * `response.error.code` of a JSON-typed `response.failed` frame decides even beside a root `code`
 * or `error`, as the Codex CLI reads it. Only when there is no code is the nested error object's
 * `type` read, and only for the limit and deactivated kinds (the HTTP rules' lists; unlike them, a
 * code present always decides). A quota kind counts only from `response.error.code` of a frame whose
 * own JSON `type` is `response.failed`: the only place the Codex CLI's stream parser reads one
 * (every other shape is retried or skipped there), so no other shape may park the account here.
 * One deliberate widening: the CLI's typed parse also rejects such a frame when a sibling field of
 * `response.error` has the wrong type (`plan_type: 42`) and retries it, and skips the whole frame
 * when a root field it parses has the wrong type (`delta: 42`) or a known root key repeats; the code
 * alone decides here.
 * The flat event's own `type` is never read: it is the event name `error`, not a code.
 *
 * The mapping is a closed list. The driver's HTTP `rules` share the limit, deactivated and quota
 * lists but not the request-shaped one:
 *   - request-shaped codes → `invalid-request` (failover reads `client-error`; no breaker strike);
 *   - a busy shared backend → `overloaded`, never struck; a refused model name → `model-unsupported`;
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
 * (f82e3659, 2026-10-13) maps the first two codes to `QuotaExceeded`, and `codex-api/src/error.rs`
 * (main, 2026-11-23) the three spend caps to `SpendLimitExceeded` and `usage_not_included` (a plan
 * that does not carry Codex) to its own error; the CLI retries none. That
 * alone does not separate permanent from clock-recoverable (the CLI does not retry a usage limit
 * either); the codes' own meaning does: a balance or a spend cap, as `insufficient_quota` means on
 * OpenAI's API (`openai-api.ts`). A ChatGPT plan's spent window arrives as `usage_limit_reached`
 * instead. No production frame carrying one has been captured. Blast radius: an account reporting
 * one goes `exhausted` until a human acts.
 *
 * Over HTTP (`openai-oauth.ts` rules): A spent balance arrives as a 429, like OpenAI's API: on
 * status alone it would cool down and be retried on a timer forever (non-negotiable 7). Only on a
 * 429, as the Codex CLI reads it (`codex-rs/codex-api/src/api_bridge.rs`), so a stray code on
 * another status cannot park an account. The CLI reads the `error` envelope only; this driver also
 * reads the `detail` envelope it reads every other Codex code from (`readCodexFacts`), a deliberate
 * widening. The CLI's other HTTP code there, `organization_usage_limit_exceeded`, is left out: its
 * name says a usage window, which a 429 already classifies as `rate-limited`. As a `type`, only
 * `insufficient_quota` and `usage_not_included`, as the CLI reads it; the rest are codes only. One
 * more difference: these run after the limit rules, so a limit code or a `rate_limit_exceeded` type beside a quota
 * signal reads `rate-limited` here where the CLI reads quota. That errs to cooldown; the stream
 * hook follows the CLI instead (quota wins there).
 */
export const CODEX_QUOTA_CODES: readonly string[] = [
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "api_key_spend_limit_exceeded",
  "usage_not_included",
]

export const CODEX_STREAM_ERROR_REQUEST_CODES: readonly string[] = [
  "invalid_prompt",
  "invalid_request_error",
  "context_length_exceeded",
  "unsupported_parameter",
  "unsupported_value",
  "invalid_json_schema",
  // Refusals of the content itself. Provenance: codex-rs `codex-api/src/error.rs`
  // `parse_terminal_provider_error`, main, 2026-11-23, which ends the turn on each of them. Blast
  // radius: read as `server-error`, a few flagged prompts from one client cooled the ChatGPT account
  // for everyone.
  "cyber_policy",
  "bio_policy",
  "content_policy_violation",
  "misalignment_policy_violation",
  "inference_hook_denied",
  "invalid_access_program",
  "unsupported_access_program",
]

/**
 * The shared backend is busy. Provenance: codex-rs `codex-api/src/sse/responses_error.rs` (stream)
 * and `api_bridge.rs` (HTTP `503`), main, 2026-11-23. Prod 2026-11-23/24 logged 26 of these in 200
 * streams by their sentence alone, so the sentence is read too where no listed code is stated. Blast
 * radius: matched failures retry on the overload budget and never strike; missed ones are
 * `server-error`, which cools the account over OpenAI's own outage.
 */
export const CODEX_OVERLOAD_CODES: readonly string[] = [
  "server_is_overloaded",
  "policy_capacity_unavailable",
]
export const CODEX_OVERLOADED_WORDING = /^our servers are currently overloaded/i

/** Provenance: `parse_terminal_provider_error`, as above: the name is wrong, not the account. */
const MODEL_REFUSED_CODES: readonly string[] = ["model_not_found"]

const KIND_BY_CODE: ReadonlyMap<string, UpstreamFailureKind> = new Map([
  ...CODEX_STREAM_ERROR_REQUEST_CODES.map((code): [string, UpstreamFailureKind] => [
    code,
    "invalid-request",
  ]),
  ...CODEX_LIMIT_CODES.map((code): [string, UpstreamFailureKind] => [code, "rate-limited"]),
  ...CODEX_OVERLOAD_CODES.map((code): [string, UpstreamFailureKind] => [code, "overloaded"]),
  ...MODEL_REFUSED_CODES.map((code): [string, UpstreamFailureKind] => [code, "model-unsupported"]),
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
  // A quota code counts only from where the Codex CLI reads it: `response.error.code` of a frame
  // whose own JSON `type` is `response.failed` (the CLI's stricter typed parse aside, see above).
  // Every other shape (a bare `error` event, a root `code` or `error`, a frame typed only by its
  // SSE event name) is retried or skipped there, so here it must not park the account.
  const quotaCode =
    root.type === "response.failed" ? text(record(record(root.response)?.error)?.code) : undefined
  // That location decides a quota code even when a root `code` or `error` would otherwise win.
  const stated = text(root.message) ?? text(nested?.message) ?? text(root.error)
  const code =
    quotaCode !== undefined && QUOTA_CODES.has(quotaCode)
      ? quotaCode
      : listed !== undefined && QUOTA_CODES.has(listed)
        ? undefined
        : (listed ?? overloadedBy(stated))
  const kind = code === undefined ? "server-error" : (KIND_BY_CODE.get(code) ?? "server-error")
  const message = stated ?? describeSilent(type, root, nested)
  return {
    kind,
    status: 200,
    retryable: isRetryableFailureKind(kind),
    signal: `${SIGNAL_PREFIX}${code ?? "other"}`,
    rateLimit: null,
    message,
  }
}

function overloadedBy(message: string | undefined): string | undefined {
  return message !== undefined && CODEX_OVERLOADED_WORDING.test(message)
    ? CODEX_OVERLOAD_CODES[0]
    : undefined
}

/**
 * A frame that ends the stream with no words of its own still says *which* frame and code it was.
 * Without this the operator's line read `upstreamMessage=null` for 41 of 45 Codex stream failures
 * (prod 2026-11-03..10, sweep 101, 10.17) and none could be diagnosed. Built from the frame type and
 * the upstream's code/status fields only — closed vocabulary, never a body.
 */
function describeSilent(
  type: string,
  root: Record<string, unknown>,
  nested: Record<string, unknown> | undefined,
): string {
  const code = text(root.code) ?? text(nested?.code) ?? text(nested?.type)
  const status = text(record(root.response)?.status)
  const parts = [
    code === undefined ? undefined : `code=${code}`,
    status === undefined ? undefined : `status=${status}`,
  ].filter((part) => part !== undefined)
  return `${type} carried no message${parts.length === 0 ? "" : ` (${parts.join(", ")})`}`
}

/**
 * The Codex driver's response observation. In-stream Codex Responses events — `response.failed`
 * and bare `error` events — are classified here, NOT in the HTTP `rules` array: a request-shaped
 * refusal in a 200 stream must not strike the breaker; an in-stream rate limit / deactivated code
 * must (`docs/idea/05-routing-and-failover.md`).
 *
 * `streamCap`: the Codex backend drops a Responses stream at about fifteen minutes with no
 * `response.completed` and no error frame. Provenance: a customer production deployment, 119 attempts over 14 d
 * ending at 895–905 s (http 200, streamed, tokens_out 0 — usage only arrives in the completed
 * frame); no router or edge clock is 900 s (plan 101, 12.8). Blast radius: only the label of an
 * already-failed attempt.
 */
export const CODEX_RESPONSE_OBSERVATION: ResponseObservationDescriptor = {
  terminalPolicy: "evidence-only",
  inspectPayload: inspectCodexStreamFrame,
  streamCap: { signal: "codex:stream-cap" },
}
