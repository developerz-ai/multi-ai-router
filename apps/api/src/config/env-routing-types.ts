import type { BoundCooldownBehavior } from "../services/routing"

/**
 * The knobs on the request path's two in-memory caches and its off-path writer.
 *
 * Every one of these is a staleness or memory bound that an operator running a
 * large pool may legitimately want to move, which is why none of them is a
 * constant in code (CLAUDE.md non-negotiable 11).
 */
export interface DataPlaneConfig {
  /**
   * How long the warm routing catalog may lag a write made by *another* replica.
   * A write by this replica refreshes it immediately, so this bounds only the
   * multi-replica case.
   */
  readonly catalogRefreshSeconds: number
  /** Verified router keys held in memory. The ceiling is memory, not correctness. */
  readonly keyCacheMax: number
  /** How long a successful key verification is reused. Revocation invalidates immediately. */
  readonly keyCacheTtlSeconds: number
  /**
   * How long a *failed* lookup is remembered. Short on purpose: this is what
   * stops a flood of bad keys from becoming a flood of queries, and a key that
   * was just minted must start working quickly.
   */
  readonly keyCacheNegativeTtlSeconds: number
  /** Session -> Account bindings held in memory, plus their fingerprint aliases. */
  readonly sessionCacheMax: number
  /**
   * How long a binding is reused before its row is re-read. It bounds only how long this replica
   * may lag another one's rebind; the row itself never expires, because an SDK session outlives
   * any cache and dropping the mapping forces a destructive replay.
   */
  readonly sessionCacheTtlSeconds: number
  /**
   * How long "this session has no binding" is remembered. Short, and for the opposite reason to
   * the key cache's: it is what keeps plain HTTP traffic on a subscription-serving router from
   * re-asking Postgres every request, while still letting a binding minted elsewhere show up.
   */
  readonly sessionCacheNegativeTtlSeconds: number
  /** Usage records held in memory before the writer sheds the oldest. Reporting degrades; traffic does not. */
  readonly usageQueueMax: number
  /**
   * Rows per insert. Validated into `1..USAGE_RECORD_MAX_BATCH_ROWS` at boot — outside that
   * range every flush loses its whole batch and reporting goes silently empty.
   */
  readonly usageBatchSize: number
  readonly usageFlushIntervalMs: number
  /**
   * How often a sustained usage-write failure or queue overflow is allowed one log line. A
   * log-throttle window, not an operational one: no retention, TTL, or sweep cadence depends on
   * it — but it is still an interval, and intervals are config (non-negotiable 11).
   */
  readonly usageLogReportIntervalMs: number
  /**
   * How long an observed quota reading may sit in this replica's memory before it is persisted.
   *
   * Not a poll: a reading only exists after a response reported one, and the writer flushes what
   * arrived. The interval bounds how much of a running process's quota state a hard kill loses —
   * and how stale the console's gauges are on the replica that did *not* serve the request.
   */
  readonly quotaWriteIntervalMs: number
  /**
   * How long a standing block the breaker just formed — `exhausted`, `needs_reauth` — may sit in
   * this replica's memory before it is written through to `accounts.status`.
   *
   * Not a poll either, and shorter than the quota interval by default because what it bounds is
   * different: a lost quota reading costs a stale gauge, a lost standing block costs the operator
   * the banner telling them an account needs topping up. Routing is unaffected at any setting —
   * the breaker holds the verdict either way.
   */
  readonly accountStatusWriteIntervalMs: number
  /**
   * The largest request body the router will read, in bytes. Over it: `413`, before any account is
   * asked and before the ceiling's worth of bytes has been buffered.
   *
   * A property of the deployment, not of the code: a router fronting agents that paste whole
   * repositories into a prompt needs a different number from one serving chat, and the memory this
   * bounds is per in-flight request.
   */
  readonly maxRequestBodyBytes: number
  readonly maximumJsonDepth: number
}

/**
 * How hard the router tries before it gives up, and how long a failing account stays out.
 *
 * These are the knobs an operator reaches for when their pool's shape does not match the
 * defaults — a two-account deployment wants a different attempt cap than a twenty-account one,
 * and a provider with a slow recovery wants a longer backoff ceiling.
 *
 * One thing no value here can change: **an attempt is never retried after bytes are on the
 * wire.** That is a correctness rule, not a tuning parameter (CLAUDE.md, "Retry a request onto
 * another account after bytes are on the wire — fail honestly").
 */
export interface FailoverConfig {
  /**
   * Operator ceiling on distinct accounts tried for one client request, before the honest failure.
   *
   * Undefined — the default — is not a missing value: it is "every eligible account", the only
   * ceiling this layer cannot name, because it depends on the pool the request was filtered down
   * to and only the failover chain has seen that (`routing/failover.ts`, `maxAttempts`). Set
   * `ROUTING_MAX_ATTEMPTS` to fail faster than the pool allows.
   */
  readonly maxAttempts: number | undefined
  /** Consecutive 5xx or connection failures before an account's breaker trips. */
  readonly failureThreshold: number
  /** First cooldown step. Doubles per consecutive failure. */
  readonly baseBackoffMs: number
  /** Ceiling on that doubling, so a long outage does not park an account for hours. */
  readonly maxBackoffMs: number
  /**
   * How long an account whose API key the provider refused (`401`/`403` read as auth) sits out
   * before one probe re-tests it. A rejected key is still reported as needing a human; this only
   * decides how often the router checks whether it still does.
   */
  readonly authFailureCooldownMs: number
  /**
   * Ceiling on that cooldown, which doubles per refused re-test: a key refused again and again
   * is re-tested less and less often, never less often than this.
   */
  readonly authFailureMaxCooldownMs: number
  /**
   * How long the one admitted half-open probe holds a recovering account before the gate reopens.
   *
   * A backstop for a probe that never reports — the chain releases the hold the instant its attempt
   * reaches a verdict. While it is held, every other request is told `429` with this instant rather
   * than being dispatched onto an account that has answered nobody yet.
   */
  readonly halfOpenHoldMs: number
  /**
   * The `Retry-After` (seconds) answered when every candidate is out for a clock-recoverable
   * reason but no reset instant is known. A pause, not a countdown: nothing is scheduled to
   * clear the condition, so the number is a polite re-ask interval rather than a promise —
   * see `routing/no-candidates.ts`.
   */
  readonly unknownResetRetryAfterSeconds: number
  /** How long the router waits on one upstream. Long, because a long completion is normal. */
  readonly upstreamTimeoutMs: number
  /** Maximum failed-response bytes inspected before closing the upstream body. */
  readonly upstreamErrorMaxBytes: number
  /** Bounded success-body observation; relayed bytes are never delayed. */
  readonly responseObservationMaxBytes: number
  /**
   * What a request does when its session is bound to an account that is merely cooling down.
   *
   * `fail` (default) answers the honest `429` with a `Retry-After` and keeps the binding — the
   * conversation stays resumable on the account that owns it. `rebind` invalidates the binding
   * instead and starts a fresh upstream session on another eligible account: the request is
   * served now rather than after the reset, at the cost of the prior turns the bound account
   * still holds. Opt-in, because the loss of those turns is real even though it is surfaced —
   * see `services/routing/binding.ts`.
   */
  readonly boundAccountCoolingDown: BoundCooldownBehavior
}

/** Cross-dialect translation tuning. A ceiling an operator lives with is config, never code. */
export interface TranslationConfig {
  /**
   * The `max_tokens` an Anthropic egress is given when the client's dialect made it optional and
   * the client omitted it. Deliberately generous: a low value truncates an answer the caller never
   * asked to truncate, which is the one failure a default must not cause silently.
   */
  readonly defaultMaxTokens: number
  readonly maximumPendingBytes: number
}
