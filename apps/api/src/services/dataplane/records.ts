import type { ProviderId } from "@multi-ai-router/core"
import type { UsageOutcome } from "@multi-ai-router/db"
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
}

export interface AttemptRecordInput {
  readonly correlationId: string
  readonly attempt: number
  readonly apiKeyId: string
  readonly accountId: string | null
  readonly provider: ProviderId | null
  readonly sessionKey: string
  readonly model: string
  readonly upstreamModel: string
  readonly tokens?: TokenCounts
  readonly timing: AttemptTiming
  readonly outcome: UsageOutcome
  readonly streamed: boolean
  readonly httpStatus: number | null
  readonly errorClass: string | null
}

export function attemptRecord(input: AttemptRecordInput): UsageRecord {
  const tokens = input.tokens ?? NO_TOKENS
  return {
    correlationId: input.correlationId,
    attempt: input.attempt,
    apiKeyId: input.apiKeyId,
    accountId: input.accountId,
    provider: input.provider,
    sessionKey: input.sessionKey,
    model: input.model,
    upstreamModel: input.upstreamModel,
    tokensIn: tokens.tokensIn,
    tokensOut: tokens.tokensOut,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
    latencyMs: Math.max(0, Math.round(input.timing.latencyMs)),
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
 * The outcome an upstream failure is recorded under. `quota_exhausted` and `credits_exhausted`
 * stay distinct all the way into the row: one comes back on a clock, the other needs a human, and
 * a report that folds them together makes a dead pool look merely throttled.
 *
 * `UsageOutcome` is `"success" | RouterErrorCode`, which has no member for "the upstream returned
 * a 4xx/5xx the router passed straight through" — `08-observability.md` names `upstream_error` and
 * `client_error` as outcomes but no such error codes exist. Those land on `no_healthy_account`
 * here; adding the codes is a `packages/core` change, not a change to this mapping's callers.
 */
const FAILURE_OUTCOMES: Readonly<Record<FailureKind, UsageOutcome>> = {
  "rate-limited": "quota_exhausted",
  "credits-exhausted": "credits_exhausted",
  auth: "upstream_auth_failed",
  timeout: "upstream_timeout",
  connection: "upstream_timeout",
  "server-error": "no_healthy_account",
  "client-error": "no_healthy_account",
  "stale-session": "no_healthy_account",
}

export function failureOutcome(kind: FailureKind): UsageOutcome {
  return FAILURE_OUTCOMES[kind]
}

export { errorClassOf, outcomeOf }
