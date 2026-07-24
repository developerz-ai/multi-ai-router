import {
  type Dialect,
  type EgressMode,
  isRouterError,
  type RouterError,
} from "@multi-ai-router/core"
import type { ProviderDriver } from "../../providers"
import type { Candidate } from "../routing"
import { upstreamUrl } from "./egress/endpoint"
import { type EgressRejection, resolveEgress } from "./egress/mode"
import type { RoutableAccount, RoutingCatalog } from "./types"

/**
 * Turning routing's ordered candidates into attempts this build can actually dispatch.
 *
 * Routing selects an Account by id and metadata and deliberately knows nothing about drivers or
 * dialects (docs/idea/01-architecture.md, dependency rule 4). So the egress decision happens here,
 * **before** any dispatch: a candidate whose dialect would need translation, whose provider has no
 * driver, or whose endpoint does not resolve is dropped from the chain rather than attempted and
 * failed. Failing over to the next candidate is exactly the right answer to "this one cannot serve
 * it" — and if none can, the reason surfaces instead of a generic error.
 */

export interface ServableCandidate {
  readonly candidate: Candidate
  readonly account: RoutableAccount
  readonly driver: ProviderDriver
  readonly dialect: Dialect
  readonly url: URL
  /** The model name this account expects. Identity unless its alias map renames it. */
  readonly upstreamModel: string
  /**
   * How this attempt reaches the upstream. Only `passthrough` is servable in this build, but the
   * value is carried rather than assumed: it lands on the `UsageRecord`, where it is what makes a
   * `router_overhead_seconds` regression attributable to a path rather than to the router at large.
   */
  readonly egressMode: EgressMode
}

export interface CandidatePlan {
  /** In failover order. Empty when nothing in the chain can be served. */
  readonly servable: readonly ServableCandidate[]
  /** Why the first unservable candidate was unservable. The error surfaced when none survive. */
  readonly rejection: EgressRejection | null
  /** A candidate whose own endpoint failed to resolve — an operator misconfiguration. */
  readonly endpointError: RouterError | null
}

export function planCandidates(
  candidates: readonly Candidate[],
  catalog: RoutingCatalog,
  ingress: Dialect,
): CandidatePlan {
  const accounts = new Map(catalog.accounts().map((account) => [account.id, account]))
  const servable: ServableCandidate[] = []
  let rejection: EgressRejection | null = null
  let endpointError: RouterError | null = null

  for (const candidate of candidates) {
    const account = accounts.get(candidate.account.id)
    if (account === undefined) continue

    const egress = resolveEgress(ingress, account)
    if (egress.mode === "rejected") {
      rejection ??= egress
      continue
    }

    let url: URL
    try {
      url = upstreamUrl(egress.driver, account.driver, egress.dialect)
    } catch (error) {
      // `resolveBaseUrl` throws a `RouterError` naming the account. One unusable endpoint must
      // not take the rest of the chain down with it.
      if (isRouterError(error)) {
        endpointError ??= error
        continue
      }
      throw error
    }

    servable.push({
      candidate,
      account,
      driver: egress.driver,
      dialect: egress.dialect,
      url,
      // The alias map is the operator's, applied by the driver, outbound-only, identity on a miss.
      upstreamModel: egress.driver.mapModelAlias(account.driver, candidate.upstreamModel),
      egressMode: egress.mode,
    })
  }

  return { servable, rejection, endpointError }
}
