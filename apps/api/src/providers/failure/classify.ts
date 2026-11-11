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
  readonly when: (facts: UpstreamErrorFacts, status: number, stated: StatedReset) => boolean
  /**
   * How long to assume the limit lasts when the response itself names no instant — no
   * `retry-after`, no limiter headers, no time in the body. Labeled `estimated` wherever it travels,
   * and never applied over a reset the provider did report. See {@link withEstimatedReset}.
   */
  readonly estimatedResetSeconds?: number
}

/**
 * Whether the response itself names when the limit lifts — a `retry-after`, or a depleted limiter's
 * reset. A rule reading *wording* yields to it: a provider that states a reset is describing a clock.
 */
export interface StatedReset {
  readonly reset: boolean
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
  "model-unsupported": true,
  "server-error": true,
  overloaded: true,
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

/**
 * The status defaults, for a body no rule recognised. `408 Request Timeout` and `425 Too Early` are
 * the server declining to wait for, or replay, *this attempt* — transient, and nothing about the
 * request is wrong, so another account gets its turn. `529` is Anthropic's (and its proxies') busy
 * backend: `overloaded` whether or not the `overloaded_error` body survived a rewriting proxy, so it
 * is retried with backoff and never held against the key.
 */
function verdictForStatus(status: number): StatusVerdict | null {
  if (status < 400) return null
  const signal = `http-status:${status}`
  if (status === 401 || status === 403) return { kind: "auth", signal }
  if (status === 402) return { kind: "credits-exhausted", signal }
  if (status === 429) return { kind: "rate-limited", signal }
  if (status === 529) return { kind: "overloaded", signal }
  if (status === 408 || status === 425 || status >= 500) return { kind: "server-error", signal }
  return { kind: "invalid-request", signal }
}

/**
 * The longest message a wording rule reads. Every provenance sentence a rule here was written from is
 * under 200 characters; past this is a gateway's HTML page or an echoed request, and an unbounded
 * read hands a quadratic regex 64 KB of upstream-controlled text on the event loop. A safety bound on
 * regex input, not a tunable: no reading changes with it.
 */
const WORDING_MAX_CHARS = 2048

/**
 * Spans an upstream quotes are values it is echoing — a model name, a block `type`, a field — and
 * the client chose them. `'…'` only where the quote is not an apostrophe (`You've` stays whole).
 */
const QUOTED_SPANS = /"[^"]*"|`[^`]*`|“[^”]*”|‘[^’]*’|(?<!\w)'[^'\n]*'(?!\w)/g

/**
 * The text a wording rule is allowed to read: capped, and with every quoted span removed. Applied
 * once here, before any rule runs, so no driver can forget it — a client that names its model
 * `insufficient balance` must never read as a dead balance (docs/idea/05-routing-and-failover.md).
 * The classification still carries the upstream's whole message; only the verdict is shielded.
 */
export function wordingOf(message: string | undefined): string | undefined {
  if (message === undefined) return undefined
  return message.slice(0, WORDING_MAX_CHARS).replace(QUOTED_SPANS, " ").trim()
}

export function classifyUpstreamFailure(
  options: ClassifyOptions,
  response: UpstreamResponse,
): FailureClassification | null {
  const facts = options.readFacts(response.body)
  const rateLimit = options.parseRateLimit(response)
  const stated = {
    reset: rateLimit?.resetsAt !== undefined || rateLimit?.retryAfterSeconds !== undefined,
  }
  const wording = { ...facts, message: wordingOf(facts.message) }
  const matched = options.rules.find((rule) => rule.when(wording, response.status, stated))
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
    rateLimit: withEstimatedReset(rateLimit, matched?.estimatedResetSeconds),
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

/**
 * Rule builders. Every driver's rules are one of the three shapes below, optionally narrowed by
 * {@link onStatus} or carrying {@link withResetEstimate}; none of them copies logic.
 */

/**
 * The same rule, matched only on the given statuses. For a message guard whose words are only a
 * verdict in one context — "suspended" on a `403` is an account taken away, on a `429` it is a
 * throttle — so the guard cannot reach a status it was never written for.
 */
export function onStatus(
  statuses: readonly number[],
  rule: ClassificationRule,
): ClassificationRule {
  return {
    ...rule,
    when: (facts, status, stated) => statuses.includes(status) && rule.when(facts, status, stated),
  }
}

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

/**
 * Where a wording rule may fire. **Required**, because upstream `4xx` messages echo client-chosen
 * text: a rule free to read any status turned `404 "model: credit balance is too low"` into a dead
 * balance and parked a healthy account `exhausted` (sweep 101, 04.1). A rule names the statuses its
 * provenance sentence was observed on, and — where the vendor types its errors — the type.
 */
export interface MessageGuard {
  readonly statuses: readonly number[]
  readonly types?: readonly string[]
}

export function messageRule(
  kind: UpstreamFailureKind,
  signal: string,
  pattern: RegExp,
  guard: MessageGuard,
): ClassificationRule {
  return {
    kind,
    signal,
    when: (facts, status) =>
      guard.statuses.includes(status) &&
      (guard.types === undefined ||
        (facts.type !== undefined && guard.types.includes(facts.type))) &&
      facts.message !== undefined &&
      pattern.test(facts.message),
  }
}
