import {
  type AccountSnapshot,
  type LimiterReading,
  mergeQuotaWindows,
  type RoutingSnapshot,
} from "../routing"
import type { AccountHealthState, HealthStore } from "./health"
import type { RotationCounters } from "./rotation"
import type { RoutingCatalog } from "./types"

/**
 * The one snapshot a request's selection reads, assembled from the warm catalog and the warm
 * health store. No I/O, no query, no clock of its own — the clock is passed in.
 *
 * Split from the store itself because they change for different reasons: the store changes when a
 * new health *signal* arrives, this changes when the pure filter needs a new *field* to decide on.
 */

/**
 * The account's routing view with live health overlaid.
 *
 * The stored status is the operator's word (`disabled`, `needs_reauth` after a failed reauth); the
 * breaker's is the router's. The breaker wins whenever it has something to say, because it is the
 * fresher of the two — but it never promotes an account the operator disabled.
 *
 * Quota windows follow the same shape and for the same reason. The catalog hydrates what was
 * persisted, which is what a just-booted replica knows; this process's own readings usually say
 * more. `mergeQuotaWindows` settles it per kind by `lastCheckedAt` — what neither names survives,
 * and a stored row that is genuinely newer (another replica's reading, or the quota floor retiring
 * an expired window) is not overwritten by a stale in-memory copy of the same window.
 */
export function overlayHealth(
  account: AccountSnapshot,
  state: AccountHealthState,
): AccountSnapshot {
  const configuredBlocks = account.status === "disabled" || account.status === "needs_reauth"
  const status =
    configuredBlocks || state.breaker.status === "active" ? account.status : state.breaker.status
  const quotaWindows = mergeQuotaWindows(account.quotaWindows ?? [], state.quotaWindows)
  const limiterWindows = state.limiterWindows.map(toLimiterReading)

  return {
    ...account,
    status,
    // Absent stays absent: routing reads an absent set as *unknown*, and an empty array is the
    // different, wrong claim that we looked and this account holds no windows.
    ...(quotaWindows.length === 0 ? {} : { quotaWindows }),
    ...(limiterWindows.length === 0 ? {} : { limiterWindows }),
    health: {
      cooldownUntil: state.breaker.cooldownUntil,
      cooldownSource: state.breaker.cooldownSource,
      consecutiveFailures: state.breaker.consecutiveFailures,
      inFlight: state.inFlight,
      recentTokens: state.recentTokens,
      // Carried, never folded into `cooldownUntil`: the hold is the router's own gate and the
      // cooldown is what the provider said. Merging them would show an operator a countdown to a
      // reset nobody reported.
      ...(state.probeHeldUntil === null ? {} : { probeHeldUntil: state.probeHeldUntil }),
    },
  }
}

/**
 * A limiter reading as selection reads it: the name, the number, and how the number was come by.
 * `limit`, `remaining`, and the reset travel no further — nothing ranks or filters on them, and a
 * field carried without a reader is a field that drifts.
 */
function toLimiterReading(window: {
  readonly limiter: string
  readonly utilization?: number
  readonly utilizationSource: LimiterReading["utilizationSource"]
}): LimiterReading {
  return {
    limiter: window.limiter,
    utilizationSource: window.utilizationSource,
    ...(window.utilization === undefined ? {} : { utilization: window.utilization }),
  }
}

/**
 * The one snapshot a request's selection reads. Built from warm memory; no I/O, no query.
 *
 * `rotation` stamps each pool with the counter its rotation policy reads this request
 * (`rotation.ts`). Absent, the pools carry whatever the catalog holds — nothing today — and every
 * rotation policy sees `0`, which a caller that is not the dispatcher (a probe, a test of the pure
 * chain) is entitled to.
 */
export function buildSnapshot(
  catalog: RoutingCatalog,
  health: Pick<HealthStore, "stateOf">,
  now: Date,
  rotation?: Pick<RotationCounters, "current">,
): RoutingSnapshot {
  const pools = catalog.pools()
  return {
    accounts: catalog
      .accounts()
      .map((account) => overlayHealth(account.snapshot, health.stateOf(account.id))),
    pools:
      rotation === undefined
        ? pools
        : pools.map((pool) => ({ ...pool, rotationCounter: rotation.current(pool.id) })),
    now,
  }
}
