import type { ProviderId, UsageOutcome } from "@multi-ai-router/core"
import { USAGE_OUTCOME_SUCCESS } from "@multi-ai-router/core"
import type { UsageRecord } from "../services/usage"

/**
 * `router_failovers_total` is exact rather than estimated, and that costs the one piece of state
 * in the metrics layer: a failed attempt is only counted as a failover once a *later* attempt of
 * the same request proves the router moved on. A chain that gave up leaves its last failure
 * uncounted, which is correct — it moved nowhere.
 */

/**
 * In-flight requests whose last attempt failed, held until a later attempt proves a failover.
 * Bounds memory when a chain ends in failure and its entry is therefore never resolved; the
 * oldest is dropped, uncounted, rather than kept forever.
 *
 * A data-structure bound, not an operator limit: an entry lives for the gap between two attempts
 * of one request, so a live map holds at most the replica's concurrently failing requests, and an
 * eviction costs one uncounted failover — never a request, a route, or a series.
 */
const MAX_PENDING_HOPS = 1_024

export interface FailoverHop {
  readonly pool_id: string
  readonly from_provider: ProviderId
  readonly reason: string
}

/** `reason` on `router_failovers_total`. Anything not quota, credits, or a deadline is upstream. */
function failoverReason(outcome: UsageOutcome): string {
  if (outcome === "quota_exhausted") return "rate_limited"
  if (outcome === "credits_exhausted") return "exhausted"
  if (outcome === "upstream_timeout") return "timeout"
  return "upstream_error"
}

/** Returns the settle step: feed it every attempt, it reports each hop a later attempt proved. */
export function createFailoverTracker(count: (hop: FailoverHop) => void) {
  const pending = new Map<string, FailoverHop>()
  return (record: UsageRecord): void => {
    const prior = pending.get(record.correlationId)
    if (prior !== undefined) {
      pending.delete(record.correlationId)
      count(prior)
    }
    if (record.outcome === USAGE_OUTCOME_SUCCESS || record.provider === null) return
    if (pending.size >= MAX_PENDING_HOPS) {
      const oldest = pending.keys().next()
      if (!oldest.done) pending.delete(oldest.value)
    }
    pending.set(record.correlationId, {
      pool_id: record.poolId ?? "none",
      from_provider: record.provider,
      reason: failoverReason(record.outcome),
    })
  }
}
