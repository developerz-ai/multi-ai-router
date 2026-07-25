import type { Dialect, EgressMode, ProviderId, UsageOutcome } from "@multi-ai-router/core"
import {
  isRouterError,
  USAGE_OUTCOME_SUCCESS,
  usageOutcomeForErrorCode,
} from "@multi-ai-router/core"
import type { CostBasis, NewUsageRecordRow } from "@multi-ai-router/db"

/**
 * One record per upstream **attempt**, not per client request. A request that failed over twice
 * emits three of these, joined by `correlationId` — the failure is the data an operator needs
 * (docs/idea/08-observability.md#usagerecord).
 *
 * A plain value, deliberately: it is built on the request path, handed to an in-memory queue, and
 * written by a background batch writer. Nothing here touches a database, a clock, or Hono.
 *
 * No prompt content, no completion content, and no credential material is ever carried on a
 * record — only counts, timings, and identifiers.
 */
export interface UsageRecord {
  /** Router-owned, shared by every attempt of one client request. See {@link correlationIdFrom}. */
  readonly correlationId: string
  /** The client's own `x-request-id`, when it sent one. See {@link clientRequestIdFrom}. */
  readonly clientRequestId: string | null
  /** 1-based position in the failover chain. */
  readonly attempt: number
  readonly apiKeyId: string | null
  /** Null when the attempt failed before an account was selected — nothing in scope. */
  readonly accountId: string | null
  /** The pool the account came from. Null for an `all`-scoped or account-scoped key. */
  readonly poolId: string | null
  readonly provider: ProviderId | null
  readonly sessionKey: string | null
  /** Exactly what the client asked for. Never substituted. */
  readonly model: string
  /** After the account's alias map. Equal to {@link model} when no alias applied. */
  readonly upstreamModel: string
  /** The API surface the client called. Null when the caller never got that far. */
  readonly ingressDialect: Dialect | null
  /** Passthrough, translate, or agent-sdk. Null when no upstream was ever addressed. */
  readonly egressMode: EgressMode | null
  /** The uncached remainder. Prompt size is this plus both cache fields — always the sum. */
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /**
   * Estimated dollars for this attempt, as a decimal string, or null when this image ships no price
   * for the model. Null is the honest value: a zero here would read as a free request.
   */
  readonly costEstimate: string | null
  /** `metered` upstream, `notional` for a subscription's attribution, `unknown` when unpriced. */
  readonly costBasis: CostBasis
  /** Router-observed wall time for this attempt. */
  readonly latencyMs: number
  /** Time to the first relayed byte. Null when no byte was relayed. */
  readonly ttfbMs: number | null
  /** Time inside the router, excluding upstream. Budgeted at <5 ms p99. */
  readonly routerOverheadMs: number
  readonly outcome: UsageOutcome
  /** Whether bytes reached the client. A streamed attempt is never retried. */
  readonly streamed: boolean
  readonly httpStatus: number | null
  /** The thrown class's name — never a message, never a body. */
  readonly errorClass: string | null
  readonly startedAt: Date
  readonly finishedAt: Date
}

export const USAGE_SUCCESS: UsageOutcome = USAGE_OUTCOME_SUCCESS

/** Zeroed counters, for an attempt that never reached a token-bearing response. */
export const NO_TOKENS = {
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
} as const

/**
 * The outcome an error ended an attempt with.
 *
 * A `RouterError` reports under the outcome its stable code maps to. Anything else is
 * `router_error` — an unclassified throw *is* a router bug, and recording it as `upstream_timeout`
 * (as this used to) invents a provider fault out of one of our own, in the one column an operator
 * reads to decide whose problem a failure is.
 */
export function outcomeOf(error: unknown): UsageOutcome {
  return isRouterError(error) ? usageOutcomeForErrorCode(error.code) : "router_error"
}

export function errorClassOf(error: unknown): string | null {
  return error instanceof Error ? error.name : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The correlation id every attempt of one request shares.
 *
 * The correlation id is **router-owned**: a join key across the attempt rows of one client request,
 * so it has to be unique per request and forgeable by nobody. The `x-request-id` a client may send
 * is a different thing — a trace label the caller controls, echoed on the response and stamped on
 * every log line — and `requestId()` deliberately accepts any `[A-Za-z0-9_.:-]{1,128}`. Treating
 * that as the join key would let two clients both sending `req-1` merge their attempt chains into
 * one, quite apart from the `uuid` column being unable to hold the value.
 *
 * So a non-UUID id is replaced rather than coerced, and the caller's own value is kept beside it by
 * {@link clientRequestIdFrom} rather than thrown away.
 */
export function correlationIdFrom(requestId: string): string {
  return UUID.test(requestId) ? requestId : crypto.randomUUID()
}

/**
 * The caller's own request id, or null when the router minted the id itself.
 *
 * A UUID reads as router-minted. A client that sends a UUID of its own therefore has it recorded as
 * the correlation id instead — the same value, in the column that joins the attempts, so nothing is
 * lost and the row stays unambiguous.
 */
export function clientRequestIdFrom(requestId: string): string | null {
  return UUID.test(requestId) ? null : requestId
}

/**
 * The persistence shape. Kept here rather than in a repository because the mapping is pure and
 * `packages/db` owns SQL, not translation.
 *
 * Every field on {@link UsageRecord} now has a column. Four of them did not: `upstreamModel`,
 * `streamed`, `httpStatus`, and `errorClass` were assembled on the request path and silently
 * dropped here, so the record's own doc comments described data that existed nowhere.
 */
export function toUsageRecordRow(record: UsageRecord): NewUsageRecordRow {
  return {
    correlationId: record.correlationId,
    clientRequestId: record.clientRequestId,
    attempt: record.attempt,
    apiKeyId: record.apiKeyId,
    accountId: record.accountId,
    poolId: record.poolId,
    provider: record.provider,
    sessionKey: record.sessionKey,
    model: record.model,
    upstreamModel: record.upstreamModel,
    ingressDialect: record.ingressDialect,
    egressMode: record.egressMode,
    tokensIn: record.tokensIn,
    tokensOut: record.tokensOut,
    cacheReadTokens: record.cacheReadTokens,
    cacheWriteTokens: record.cacheWriteTokens,
    costEstimate: record.costEstimate,
    costBasis: record.costBasis,
    latencyMs: record.latencyMs,
    ttfbMs: record.ttfbMs,
    routerOverheadMs: record.routerOverheadMs,
    outcome: record.outcome,
    streamed: record.streamed,
    httpStatus: record.httpStatus,
    errorClass: record.errorClass,
    createdAt: record.startedAt,
  }
}
