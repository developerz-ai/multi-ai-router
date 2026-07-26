import type { AccountSnapshot, RoutingSnapshot } from "../routing"
import type { AccountHealthState, HealthStore } from "./health"
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
 */
export function overlayHealth(
  account: AccountSnapshot,
  state: AccountHealthState,
): AccountSnapshot {
  const configuredBlocks = account.status === "disabled" || account.status === "needs_reauth"
  const status =
    configuredBlocks || state.breaker.status === "active" ? account.status : state.breaker.status

  return {
    ...account,
    status,
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

/** The one snapshot a request's selection reads. Built from warm memory; no I/O, no query. */
export function buildSnapshot(
  catalog: RoutingCatalog,
  health: Pick<HealthStore, "stateOf">,
  now: Date,
): RoutingSnapshot {
  return {
    accounts: catalog
      .accounts()
      .map((account) => overlayHealth(account.snapshot, health.stateOf(account.id))),
    pools: catalog.pools(),
    now,
  }
}
