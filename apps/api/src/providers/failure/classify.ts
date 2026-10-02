import type {
  FailureClassification,
  RateLimitSignal,
  UpstreamErrorFacts,
  UpstreamFailureKind,
  UpstreamResponse,
} from "../types"

/**
 * Turning an upstream response into an outcome. The shared half is here; the half that differs
 * per provider — how each one *words* a dead balance — is a rule list supplied by the driver.
 *
 * The distinction this exists to protect: `rate-limited` is clock-recoverable (`cooling_down`,
 * `429` + `Retry-After`) and `credits-exhausted` is not (`exhausted`, `402`, human action only).
 * Every provider announces the second differently, and OpenAI announces it *as a 429*, so status
 * alone is not enough (docs/idea/05-routing-and-failover.md).
 */

export interface ClassificationRule {
  readonly kind: UpstreamFailureKind
  /** Recorded on the classification so a misclassification is traceable to its trigger. */
  readonly signal: string
  readonly when: (facts: UpstreamErrorFacts, status: number) => boolean
  /**
   * How long to assume the limit lasts when the response itself names no instant — no
   * `retry-after`, no limiter headers, no time in the body. Labeled `estimated` wherever it travels,
   * and never applied over a reset the provider did report. See {@link withEstimatedReset}.
   */
  readonly estimatedResetSeconds?: number
}

export interface ClassifyOptions {
  /** Provider-specific rules, evaluated in order, before the status-code defaults. */
  readonly rules: readonly ClassificationRule[]
  readonly readFacts: (body: unknown) => UpstreamErrorFacts
  readonly parseRateLimit: (response: UpstreamResponse) => RateLimitSignal | null
}

/**
 * Whether the router may try the **next candidate account**. `invalid-request` is false: a bad
 * request is bad at every account. `auth` is true for the opposite reason — a rejected credential is
 * *this account's* problem, and the breaker parks the account (`needs_reauth`, or a
 * `credential-rejected` cooldown for a key) before the chain moves on; the next account authenticates with its own credential, so it gets its turn.
 * Before this was true, the first request to land on an expired subscription failed `502` while
 * healthy accounts sat beside it, and only the *next* request routed around the parked one.
 *
 * The two session kinds are false for a different reason: their recovery is on the *same* account —
 * a replay in place, or a wait and a fork — and it happens before the failover planner is consulted
 * at all (docs/idea/05-routing-and-failover.md, "a stale session is not a failover"). A dead
 * subprocess carries no such claim, so the next account gets its turn.
 *
 * `unknown` is true because that is what the chain does with one: `failoverKind`
 * (`services/dataplane/attempt.ts`) has no mapping for it and falls back to the status, and every
 * `unknown` is a `502` — a `server-error`, which fails over. An unreadable failure is still one
 * account failing; this flag said otherwise for a while and nothing read it.
 */
const RETRYABLE: Readonly<Record<UpstreamFailureKind, boolean>> = {
  "rate-limited": true,
  "credits-exhausted": true,
  auth: true,
  "invalid-request": false,
  "server-error": true,
  "stale-session": false,
  "busy-session": false,
  "subprocess-crash": true,
  unknown: true,
}

/** One table, both transports: an SDK failure answers this question the same way an HTTP one does. */
export function isRetryableFailureKind(kind: UpstreamFailureKind): boolean {
  return RETRYABLE[kind]
}

interface StatusVerdict {
  readonly kind: UpstreamFailureKind
  readonly signal: string
}

function verdictForStatus(status: number): StatusVerdict | null {
  if (status < 400) return null
  const signal = `http-status:${status}`
  if (status === 401 || status === 403) return { kind: "auth", signal }
  if (status === 402) return { kind: "credits-exhausted", signal }
  if (status === 429) return { kind: "rate-limited", signal }
  if (status >= 500) return { kind: "server-error", signal }
  return { kind: "invalid-request", signal }
}

export function classifyUpstreamFailure(
  options: ClassifyOptions,
  response: UpstreamResponse,
): FailureClassification | null {
  const facts = options.readFacts(response.body)
  const matched = options.rules.find((rule) => rule.when(facts, response.status))
  const verdict: StatusVerdict | null = matched
    ? { kind: matched.kind, signal: matched.signal }
    : verdictForStatus(response.status)

  if (!verdict) return null

  return {
    kind: verdict.kind,
    status: response.status,
    retryable: RETRYABLE[verdict.kind],
    signal: verdict.signal,
    message: facts.message,
    rateLimit: withEstimatedReset(options.parseRateLimit(response), matched?.estimatedResetSeconds),
  }
}

/**
 * A rule's estimated reset, folded in only where the response reported none.
 *
 * Without it a limit that names no instant reaches the breaker as "nothing reported" and falls to
 * exponential backoff — a probe at 1s, 2s, 4s… against a window that will not reopen for hours. With
 * it the cooldown has a sensible length and, because the source is `estimated`, the client's error
 * says so ("earliest reset … (estimated)") instead of passing our arithmetic off as the provider's.
 */
function withEstimatedReset(
  parsed: RateLimitSignal | null,
  estimatedSeconds: number | undefined,
): RateLimitSignal | null {
  if (estimatedSeconds === undefined) return parsed
  if (parsed?.resetsAt !== undefined || parsed?.retryAfterSeconds !== undefined) return parsed
  return {
    limited: true,
    retryAfterSeconds: estimatedSeconds,
    resetSource: "estimated",
    windows: parsed?.windows ?? [],
    ...(parsed?.quotaWindows === undefined ? {} : { quotaWindows: parsed.quotaWindows }),
  }
}

/** Rule builders. Every driver's rules are one of these three shapes; none of them copies logic. */

/** The same rule, carrying an estimated reset for responses that name none. */
export function withResetEstimate(
  rule: ClassificationRule,
  estimatedResetSeconds: number,
): ClassificationRule {
  return { ...rule, estimatedResetSeconds }
}

export function codeRule(
  kind: UpstreamFailureKind,
  signal: string,
  codes: readonly string[],
): ClassificationRule {
  return { kind, signal, when: (facts) => facts.code !== undefined && codes.includes(facts.code) }
}

export function typeRule(
  kind: UpstreamFailureKind,
  signal: string,
  types: readonly string[],
): ClassificationRule {
  return { kind, signal, when: (facts) => facts.type !== undefined && types.includes(facts.type) }
}

export function messageRule(
  kind: UpstreamFailureKind,
  signal: string,
  pattern: RegExp,
): ClassificationRule {
  return {
    kind,
    signal,
    when: (facts) => facts.message !== undefined && pattern.test(facts.message),
  }
}
