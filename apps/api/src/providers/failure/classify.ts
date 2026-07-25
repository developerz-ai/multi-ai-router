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
}

export interface ClassifyOptions {
  /** Provider-specific rules, evaluated in order, before the status-code defaults. */
  readonly rules: readonly ClassificationRule[]
  readonly readFacts: (body: unknown) => UpstreamErrorFacts
  readonly parseRateLimit: (response: UpstreamResponse) => RateLimitSignal | null
}

/**
 * Whether the router may try the **next candidate account**. `auth` and `invalid-request` are
 * false: a bad request is bad at every account, and a rejected credential is this account's
 * problem to fix, not the next account's to absorb.
 *
 * The two session kinds are false for a different reason: their recovery is on the *same* account —
 * a replay in place, or a wait and a fork — and it happens before the failover planner is consulted
 * at all (docs/idea/05-routing-and-failover.md, "a stale session is not a failover"). A dead
 * subprocess carries no such claim, so the next account gets its turn.
 */
const RETRYABLE: Readonly<Record<UpstreamFailureKind, boolean>> = {
  "rate-limited": true,
  "credits-exhausted": true,
  auth: false,
  "invalid-request": false,
  "server-error": true,
  "stale-session": false,
  "busy-session": false,
  "subprocess-crash": true,
  unknown: false,
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
    rateLimit: options.parseRateLimit(response),
  }
}

/** Rule builders. Every driver's rules are one of these three shapes; none of them copies logic. */

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
