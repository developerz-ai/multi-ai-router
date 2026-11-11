import { type HealthStore, overlayHealth, type RoutingCatalog } from "../dataplane"
import { accountLookup } from "../dataplane/types"
import { DEFAULT_QUOTA_SPENT_THRESHOLD } from "../routing"
import { accountIsLiveHealthy } from "../routing/recovery-filter"

export interface LiveHealthDeps {
  readonly catalog: RoutingCatalog
  readonly health: Pick<HealthStore, "stateOf">
  readonly now: () => Date
  readonly quotaSpentThreshold?: number
}

/**
 * `RecheckServiceDeps.isLiveHealthy` from the warm catalog and health store: the same overlay the
 * request path reads, so a re-check and the router agree on whether anything holds the account out.
 * An account the warm catalog does not hold yet is not known healthy.
 */
export function liveHealthCheck(deps: LiveHealthDeps): (accountId: string) => boolean {
  return (accountId) => {
    const account = accountLookup(deps.catalog)(accountId)
    if (account === undefined) return false
    return accountIsLiveHealthy(
      overlayHealth(account.snapshot, deps.health.stateOf(accountId)),
      deps.now(),
      deps.quotaSpentThreshold ?? DEFAULT_QUOTA_SPENT_THRESHOLD,
    )
  }
}
