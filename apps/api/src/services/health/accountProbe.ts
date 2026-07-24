import { isStandingBlock } from "@multi-ai-router/core"
import { buildSnapshot, type HealthStore, type RoutingCatalog } from "../dataplane"
import type { AccountReadiness } from "./readiness"

/**
 * The account half of `/readyz`, answered from **warm memory**.
 *
 * It builds the same snapshot the request path builds — the catalog overlaid with live health —
 * so what it reports is what routing would actually see. A probe that computed availability its
 * own way could disagree with the router about the state of the world, which is worse than no
 * probe at all: this endpoint exists to be believed.
 *
 * It is also free: no database round trip, so an orchestrator polling every few seconds costs
 * nothing and cannot itself become the reason the database is slow.
 */

export interface AccountProbeDeps {
  readonly catalog: RoutingCatalog
  readonly health: HealthStore
  readonly now?: () => Date
}

export function createAccountProbe(deps: AccountProbeDeps): () => Promise<AccountReadiness> {
  const now = deps.now ?? (() => new Date())

  return () => {
    const snapshot = buildSnapshot(deps.catalog, deps.health, now())
    if (snapshot.accounts.length === 0) return Promise.resolve("none")

    // `cooling_down` counts as available: it clears on a clock with nobody intervening, and
    // reporting a router as having nothing routable during a one-minute backoff is alarm fatigue
    // rather than information. `isStandingBlock` is the same rule `/v1/models` applies.
    const available = snapshot.accounts.some((account) => !isStandingBlock(account.status))
    return Promise.resolve(available ? "ok" : "blocked")
  }
}
