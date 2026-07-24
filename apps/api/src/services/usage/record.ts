import { isRouterError, type ProviderId } from "@multi-ai-router/core"
import type { NewUsageRecordRow, UsageOutcome } from "@multi-ai-router/db"
import { USAGE_OUTCOME_SUCCESS } from "@multi-ai-router/db"

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
  /** Shared by every attempt of one client request. See {@link correlationIdFrom}. */
  readonly correlationId: string
  /** 1-based position in the failover chain. */
  readonly attempt: number
  readonly apiKeyId: string | null
  /** Null when the attempt failed before an account was selected — nothing in scope. */
  readonly accountId: string | null
  readonly provider: ProviderId | null
  readonly sessionKey: string | null
  /** Exactly what the client asked for. Never substituted. */
  readonly model: string
  /** After the account's alias map. Equal to {@link model} when no alias applied. */
  readonly upstreamModel: string
  /** The uncached remainder. Prompt size is this plus both cache fields — always the sum. */
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** Router-observed wall time for this attempt. */
  readonly latencyMs: number
  /** Time inside the router, excluding upstream. Budgeted at <5 ms p99. */
  readonly routerOverheadMs: number
  readonly outcome: UsageOutcome
  /** Whether bytes reached the client. A streamed attempt is never retried. */
  readonly streamed: boolean
  readonly httpStatus: number | null
  /** The `RouterError` subclass name — never a message, never a body. */
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
 * The outcome an error ended an attempt with. A `RouterError` contributes its stable code; a
 * thrown anything-else is recorded generically rather than guessing a code that does not exist.
 */
export function outcomeOf(error: unknown): UsageOutcome {
  return isRouterError(error) ? error.code : "upstream_timeout"
}

export function errorClassOf(error: unknown): string | null {
  return error instanceof Error ? error.name : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The correlation id every attempt of one request shares.
 *
 * The request id is the intended source (docs/idea/01-architecture.md), but `requestId()` honors a
 * caller-supplied value and `usage_records.correlation_id` is a Postgres `uuid` column — so a
 * client sending `x-request-id: req-42` would otherwise fail every insert for that request. A
 * non-UUID id is replaced rather than coerced: the rows still join, and the request id is still on
 * every log line.
 */
export function correlationIdFrom(requestId: string): string {
  return UUID.test(requestId) ? requestId : crypto.randomUUID()
}

/**
 * The persistence shape. Kept here rather than in a repository because the mapping is pure and
 * `packages/db` owns SQL, not translation.
 *
 * Four fields on {@link UsageRecord} have no column yet — `upstreamModel`, `streamed`,
 * `httpStatus`, `errorClass` — so they are dropped here. They are on the record because the spec
 * names them and because the log line and metrics read them; adding the columns is a migration in
 * `packages/db`, not a change to this file's callers.
 */
export function toUsageRecordRow(record: UsageRecord): NewUsageRecordRow {
  return {
    correlationId: record.correlationId,
    attempt: record.attempt,
    apiKeyId: record.apiKeyId,
    accountId: record.accountId,
    provider: record.provider,
    sessionKey: record.sessionKey,
    model: record.model,
    tokensIn: record.tokensIn,
    tokensOut: record.tokensOut,
    cacheReadTokens: record.cacheReadTokens,
    cacheWriteTokens: record.cacheWriteTokens,
    latencyMs: record.latencyMs,
    routerOverheadMs: record.routerOverheadMs,
    outcome: record.outcome,
    createdAt: record.startedAt,
  }
}
