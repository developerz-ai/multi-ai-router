import type { Dialect, EgressMode, ProviderId, UsageOutcome } from "@multi-ai-router/core"
import type { FailureKind } from "../routing"
import type { UsageRecord } from "../usage"
import { errorClassOf, NO_TOKENS, outcomeOf, type TokenCounts, USAGE_SUCCESS } from "../usage"

/**
 * Building the per-attempt usage record.
 *
 * Kept apart from the dispatch loop because it is pure bookkeeping over values the loop already
 * has: which key, which account, which attempt, how long, how it ended. One row per **attempt** —
 * a request that failed over twice writes three, joined by the correlation id.
 *
 * `routerOverheadMs` is the record's half of `router_overhead_seconds`: total router-observed time
 * minus the time spent waiting on upstreams. A regression in it is a bug, so it is computed rather
 * than estimated, and it never goes negative on a clock hiccup.
 */

export interface AttemptTiming {
  readonly startedAt: Date
  readonly finishedAt: Date
  /** Wall time of this attempt, upstream included. */
  readonly latencyMs: number
  /** Router-observed time for the whole request so far. */
  readonly totalMs: number
  /** Time spent waiting on upstreams for the whole request so far. */
  readonly upstreamMs: number
  /**
   * Time to the first relayed byte, when one was relayed.
   *
   * Separate from `latencyMs` because only this one can catch a violation of the zero-added
   * time-to-first-token rule: total latency is dominated by generation time, so a relay that
   * started buffering would barely move it.
   */
  readonly ttfbMs?: number
}

/**
 * Everything the record needs that the dispatch loop already knows.
 *
 * The optional members are the ones a caller may genuinely not have: an attempt that never selected
 * an account has no pool and no egress mode, and a non-streamed or failed attempt has no first
 * byte. Absent is recorded as NULL, never as zero — a TTFB of 0 ms is a claim nobody measured.
 */
export interface AttemptRecordInput {
  readonly correlationId: string
  readonly clientRequestId?: string | null
  readonly attempt: number
  readonly apiKeyId: string
  readonly accountId: string | null
  readonly poolId?: string | null
  readonly provider: ProviderId | null
  readonly sessionKey: string
  readonly model: string
  readonly upstreamModel: string
  readonly ingressDialect?: Dialect | null
  readonly egressMode?: EgressMode | null
  readonly tokens?: TokenCounts
  readonly timing: AttemptTiming
  readonly outcome: UsageOutcome
  readonly streamed: boolean
  readonly httpStatus: number | null
  readonly errorClass: string | null
}

export function attemptRecord(input: AttemptRecordInput): UsageRecord {
  const tokens = input.tokens ?? NO_TOKENS
  const ttfbMs = input.timing.ttfbMs
  return {
    correlationId: input.correlationId,
    clientRequestId: input.clientRequestId ?? null,
    attempt: input.attempt,
    apiKeyId: input.apiKeyId,
    accountId: input.accountId,
    poolId: input.poolId ?? null,
    provider: input.provider,
    sessionKey: input.sessionKey,
    model: input.model,
    upstreamModel: input.upstreamModel,
    ingressDialect: input.ingressDialect ?? null,
    egressMode: input.egressMode ?? null,
    tokensIn: tokens.tokensIn,
    tokensOut: tokens.tokensOut,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
    latencyMs: Math.max(0, Math.round(input.timing.latencyMs)),
    ttfbMs: ttfbMs === undefined ? null : Math.max(0, Math.round(ttfbMs)),
    routerOverheadMs: Math.max(0, Math.round(input.timing.totalMs - input.timing.upstreamMs)),
    outcome: input.outcome,
    streamed: input.streamed,
    httpStatus: input.httpStatus,
    errorClass: input.errorClass,
    startedAt: input.timing.startedAt,
    finishedAt: input.timing.finishedAt,
  }
}

export const SUCCESS_OUTCOME = USAGE_SUCCESS

/**
 * The outcome an upstream failure is recorded under.
 *
 * `quota_exhausted` and `credits_exhausted` stay distinct all the way into the row: one comes back
 * on a clock, the other needs a human, and a report that folds them together makes a dead pool look
 * merely throttled.
 *
 * The kinds that are nobody's quota problem — a 5xx, a refused connection, an SDK session the
 * account no longer knows — report as `upstream_error`, and a malformed request as `client_error`.
 * All four used to land on `no_healthy_account`, which told an operator the pool was out of
 * capacity when the provider had a bad minute or the caller sent bad JSON. `httpStatus` separates
 * "the upstream answered with an error" from "we never reached it": an integer versus NULL.
 */
const FAILURE_OUTCOMES: Readonly<Record<FailureKind, UsageOutcome>> = {
  "rate-limited": "quota_exhausted",
  "credits-exhausted": "credits_exhausted",
  auth: "upstream_auth_failed",
  timeout: "upstream_timeout",
  connection: "upstream_error",
  "server-error": "upstream_error",
  "client-error": "client_error",
  "stale-session": "upstream_error",
}

export function failureOutcome(kind: FailureKind): UsageOutcome {
  return FAILURE_OUTCOMES[kind]
}

export { errorClassOf, outcomeOf }
