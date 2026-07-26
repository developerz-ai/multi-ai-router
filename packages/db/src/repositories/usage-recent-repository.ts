import type { Dialect, EgressMode, ProviderId, UsageOutcome } from "@multi-ai-router/core"
import { and, desc, inArray, isNotNull, or, sql } from "drizzle-orm"
import type { Database } from "../client"
import { usageRecords } from "../schema/usage-records"

/**
 * The live request feed — individual `usage_records` rows, newest first.
 *
 * A third reader over one table, and the split is by *shape*, not by size:
 * `usage-repository.ts` is the batch writer the request path feeds,
 * `usage-read-repository.ts` aggregates for the charts, and this one hands back
 * attempts one at a time. An aggregate can say 3% of requests failed; only a row
 * can say *which* request failed, on which account, with which error class — and
 * that is the question this exists for. Today the answer is only in the logs.
 *
 * **Columns are named, never `select()`-all.** `sessionKey` and the cost columns
 * are deliberately absent: the first is a caller-supplied conversation
 * identifier this surface has no use for, the second is the summary's job. A new
 * column on the table does not silently appear on an admin screen.
 *
 * Every predicate here rides an index: the feed orders by
 * `usage_records_created_at_idx`, and a lookup by request id rides
 * `usage_records_client_request_idx` (partial — the column is NULL on every row
 * whose id the router minted).
 */

export interface RecentAttemptQuery {
  /** Hard bound on one page. The caller validates the range; this applies it. */
  readonly limit: number
  /**
   * Keep only these outcomes. Absent means every outcome — an **empty array is
   * not the same thing** and would correctly match nothing, so callers that mean
   * "no filter" pass `undefined`.
   */
  readonly outcomes?: readonly UsageOutcome[]
  /**
   * One request id, matched against the router's `correlation_id` **and** the
   * client's `x-request-id`. An operator holding an id off a failed tool run has
   * no idea which of the two they are looking at, so asking them to pick would
   * be asking them to guess.
   */
  readonly requestId?: string
}

/**
 * One attempt as the feed renders it. A subset of `UsageRecordRow`, restated
 * rather than `Pick`ed so the wire shape of an admin surface is one explicit
 * list and not a projection that widens when the table does.
 */
export interface RecentAttemptRow {
  readonly id: string
  /** Shared by every attempt of one client request — the failover chain's key. */
  readonly correlationId: string
  /** The caller's `x-request-id`, when it sent one. Never unique, never a join key. */
  readonly clientRequestId: string | null
  /** 1-based position in the failover chain. */
  readonly attempt: number
  readonly apiKeyId: string | null
  readonly accountId: string | null
  readonly poolId: string | null
  readonly provider: ProviderId | null
  readonly model: string
  /** What went on the wire after the account's alias map. Null when nothing was sent. */
  readonly upstreamModel: string | null
  readonly ingressDialect: Dialect | null
  readonly egressMode: EgressMode | null
  readonly outcome: UsageOutcome
  /** The upstream's status when it answered. NULL means we never reached it. */
  readonly httpStatus: number | null
  /** The thrown class's name. Never a message, never a body. */
  readonly errorClass: string | null
  readonly latencyMs: number
  readonly ttfbMs: number | null
  readonly routerOverheadMs: number
  readonly streamed: boolean
  readonly tokensIn: number
  readonly tokensOut: number
  readonly createdAt: Date
}

export interface UsageRecentRepository {
  /** Newest first, bounded by `query.limit`. */
  recent(query: RecentAttemptQuery): Promise<RecentAttemptRow[]>
}

const COLUMNS = {
  id: usageRecords.id,
  correlationId: usageRecords.correlationId,
  clientRequestId: usageRecords.clientRequestId,
  attempt: usageRecords.attempt,
  apiKeyId: usageRecords.apiKeyId,
  accountId: usageRecords.accountId,
  poolId: usageRecords.poolId,
  provider: usageRecords.provider,
  model: usageRecords.model,
  upstreamModel: usageRecords.upstreamModel,
  ingressDialect: usageRecords.ingressDialect,
  egressMode: usageRecords.egressMode,
  outcome: usageRecords.outcome,
  httpStatus: usageRecords.httpStatus,
  errorClass: usageRecords.errorClass,
  latencyMs: usageRecords.latencyMs,
  ttfbMs: usageRecords.ttfbMs,
  routerOverheadMs: usageRecords.routerOverheadMs,
  streamed: usageRecords.streamed,
  tokensIn: usageRecords.tokensIn,
  tokensOut: usageRecords.tokensOut,
  createdAt: usageRecords.createdAt,
} as const

export function createUsageRecentRepository(db: Database): UsageRecentRepository {
  return {
    recent: async (query) => {
      const predicates = [
        query.outcomes === undefined
          ? undefined
          : inArray(usageRecords.outcome, [...query.outcomes]),
        query.requestId === undefined ? undefined : matchesRequestId(query.requestId),
      ].filter((predicate) => predicate !== undefined)

      return (
        db
          .select(COLUMNS)
          .from(usageRecords)
          .where(predicates.length === 0 ? undefined : and(...predicates))
          // `id` breaks ties, because `created_at` alone does not order a feed
          // deterministically: attempts of one failover chain are written from one
          // batch and can share a millisecond, and a page whose rows reshuffle
          // between two refreshes reads as traffic that did not happen.
          .orderBy(desc(usageRecords.createdAt), desc(usageRecords.id))
          .limit(query.limit)
      )
    },
  }
}

/**
 * Either id, without asking the operator which one they hold.
 *
 * `correlation_id` is a `uuid` column, so it is compared as text — a non-uuid
 * string handed to a `uuid` comparison is a Postgres *error*, not a non-match,
 * and "req-42" is exactly the value this lookup exists to accept. The
 * `client_request_id` half is guarded by `is not null` so it rides the partial
 * index rather than falling back to a sequential scan.
 */
function matchesRequestId(requestId: string) {
  return or(
    sql`${usageRecords.correlationId}::text = ${requestId}`,
    and(
      isNotNull(usageRecords.clientRequestId),
      sql`${usageRecords.clientRequestId} = ${requestId}`,
    ),
  )
}
