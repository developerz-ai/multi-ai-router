import { isRetryableFailureKind } from "../failure/classify"
import type { FailureClassification } from "../types"
import {
  any,
  apiStatus,
  CREDITS_SPENT,
  type Haystack,
  NEEDS_REAUTH,
  SDK_FAILURE_RULES,
  type SdkRule,
  statusToken,
  UNCLASSIFIED_SDK_RULE,
  WINDOW_SPENT,
} from "./failure-rules"

/**
 * What an Agent-SDK failure *is* (docs/idea/11-anthropic-agent-sdk.md §9).
 *
 * `ProviderDriver.classifyFailure` reads a status line and a provider-shaped body. Neither exists
 * here: `query()` throws, and what it throws is prose — the CLI's own sentence, sometimes with the
 * subprocess's stderr behind it — or the renderer raises a failed `result` as `SdkResultError`
 * (`result-error.ts`), which carries the same prose plus the two structured facts the SDK adds
 * beside it. So this is substring matching, which is exactly as brittle as it sounds, and the
 * mitigations are structural rather than hopeful:
 *
 * - **Ordered, most specific first.** A named phrase beats a bare status token every time, so an
 *   incidental number inside a longer message cannot outrank the sentence that explains it — and
 *   the SDK's `api_error_status` is read *after* every phrase, because Anthropic answers a dead
 *   credit balance with a `400` and the sentence is the fact that matters.
 * - **A bare status token is read from the message only, never from the stderr tail.** Meridian
 *   maps a generic `exit 1` to `401` on a heuristic and so reports every crash as an auth failure —
 *   which marks a perfectly good Account `needs_reauth` and drops it from routing until a human
 *   logs in again. A `401` somewhere in a megabyte of stderr is not evidence about *this* failure.
 * - **The SDK's own words never reach a client.** Every class carries a router-authored sentence;
 *   the raw text rides `FailureClassification.message`, whose contract already says it is for logs.
 *
 * The table itself lives in `failure-rules.ts`. Classification is where this module stops: it never
 * refreshes a credential — the SDK owns the token and an expired one is `needs_reauth`, not a retry
 * (§3) — and it never performs the recovery it names: replaying a stale session and forking a busy
 * one are the transport's and the failover planner's, which is also why the classes are values in
 * the shared `UpstreamFailureKind` vocabulary rather than a second private enum.
 */

/**
 * How much of the subprocess's stderr is read. Bounded because it is unbounded at the source, and
 * because the tail is where the cause is: a crash prints its reason last.
 */
export const STDERR_TAIL_LIMIT = 2_000

export interface SdkFailureText {
  /** The thrown error's own message. Empty when it had none. */
  readonly message: string
  /** The last {@link STDERR_TAIL_LIMIT} characters of the subprocess's stderr, when it had any. */
  readonly stderrTail: string
  /** The upstream HTTP status a failed `result` reported, when the SDK stated one. */
  readonly apiErrorStatus: number | null
  /** The SDK's own reason a `result` stopped, when it named one. */
  readonly terminalReason: string | null
}

export interface SdkFailure {
  /** The same shape an HTTP driver produces, so one failover chain reads both transports. */
  readonly classification: FailureClassification
  /**
   * Router-authored and safe to render. It is what a client sees when no account could serve, so it
   * names the class and nothing else — never a path, a session id, or the SDK's own wording.
   */
  readonly clientMessage: string
  /** What was matched against. Kept for the log line; never rendered into a response. */
  readonly text: SdkFailureText
}

/**
 * The structured fallbacks, after every phrase: a status the SDK stated, for a sentence nobody has
 * recorded yet. Strictly better than `unknown` — a `401` nobody has words for is still a
 * credential that needs a human — and never better than a named phrase.
 */
const STATUS_RULES: readonly SdkRule[] = [
  {
    kind: "auth",
    signal: "claude-sdk:api-status-401",
    status: 401,
    clientMessage: NEEDS_REAUTH,
    match: any(apiStatus(401, 403), statusToken(401)),
  },
  {
    kind: "credits-exhausted",
    signal: "claude-sdk:api-status-402",
    status: 402,
    clientMessage: CREDITS_SPENT,
    match: apiStatus(402),
  },
  {
    kind: "rate-limited",
    signal: "claude-sdk:api-status-429",
    status: 429,
    clientMessage: WINDOW_SPENT,
    match: any(apiStatus(429), statusToken(429)),
  },
  {
    kind: "invalid-request",
    signal: "claude-sdk:api-status-400",
    status: 400,
    clientMessage: "the upstream rejected the request as malformed",
    match: apiStatus(400, 413, 422),
  },
  {
    kind: "server-error",
    signal: "claude-sdk:api-status-5xx",
    status: 502,
    clientMessage: "the upstream failed to answer",
    match: (text) => text.apiErrorStatus !== null && text.apiErrorStatus >= 500,
  },
]

const RULES: readonly SdkRule[] = [...SDK_FAILURE_RULES, ...STATUS_RULES]

export function classifySdkFailure(error: unknown): SdkFailure {
  const text = readSdkFailure(error)
  const haystack: Haystack = {
    message: text.message.toLowerCase(),
    all: `${text.message}\n${text.stderrTail}`.toLowerCase(),
    apiErrorStatus: text.apiErrorStatus,
    terminalReason: text.terminalReason,
  }
  const rule = RULES.find((candidate) => candidate.match(haystack)) ?? UNCLASSIFIED_SDK_RULE

  return {
    classification: {
      kind: rule.kind,
      status: rule.status,
      retryable: isRetryableFailureKind(rule.kind),
      signal: rule.signal,
      // Rate-limit *detail* rides the query stream, not the throw: `quota.ts` already folded the
      // reset instant in from the account's own `rate_limit_event`, so inventing one here would
      // overwrite a provider-reported window with a guess.
      rateLimit: null,
      ...(text.message === "" ? {} : { message: text.message }),
    },
    clientMessage: rule.clientMessage,
    text,
  }
}

/** Everything a throw out of `query()` can be matched against, in one bounded shape. */
export function readSdkFailure(error: unknown): SdkFailureText {
  if (typeof error === "string") {
    return { message: error, stderrTail: "", apiErrorStatus: null, terminalReason: null }
  }
  if (typeof error !== "object" || error === null) {
    return { message: "", stderrTail: "", apiErrorStatus: null, terminalReason: null }
  }

  return {
    message: stringProperty(error, "message"),
    stderrTail: tail(stringProperty(error, "stderr")),
    // Only ever set by `SdkResultError` — the names are this router's, so a foreign error object
    // carrying a `status` of its own (a fetch failure, say) is never mistaken for the SDK's word.
    apiErrorStatus: statusProperty(error, "apiErrorStatus"),
    terminalReason: nonEmpty(stringProperty(error, "terminalReason")),
  }
}

function stringProperty(source: object, key: string): string {
  const value: unknown = Reflect.get(source, key)
  return typeof value === "string" ? value : ""
}

function statusProperty(source: object, key: string): number | null {
  const value: unknown = Reflect.get(source, key)
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null
}

function nonEmpty(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

function tail(value: string): string {
  return value.length <= STDERR_TAIL_LIMIT ? value : value.slice(-STDERR_TAIL_LIMIT)
}
