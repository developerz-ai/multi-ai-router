import {
  type Dialect,
  type EgressMode,
  isRouterError,
  type RouterError,
} from "@multi-ai-router/core"
import type { ProviderDriver } from "../../providers"
import type { Candidate } from "../routing"
import type { TranslationPair } from "../translate"
import { upstreamUrl } from "./egress/endpoint"
import { type EgressRejection, resolveEgress } from "./egress/mode"
import type { RoutableAccount, RoutingCatalog } from "./types"

/**
 * Turning routing's ordered candidates into attempts this build can actually dispatch.
 *
 * Routing selects an Account by id and metadata and deliberately knows nothing about drivers or
 * dialects (docs/idea/01-architecture.md, dependency rule 4). So the egress decision happens here,
 * **before** any dispatch: a candidate whose dialect pair has no translator, whose provider has no
 * driver, or whose endpoint does not resolve is dropped from the chain rather than attempted and
 * failed. Failing over to the next candidate is exactly the right answer to "this one cannot serve
 * it" — and if none can, the reason surfaces instead of a generic error.
 *
 * A chain is free to mix modes. An anthropic request over a pool holding one Anthropic account and
 * one OpenAI-compatible account plans a passthrough attempt followed by a translated one, in the
 * order routing chose — which is why the conversion is carried per candidate rather than decided
 * once for the request.
 */

export interface ServableCandidate {
  readonly candidate: Candidate
  readonly account: RoutableAccount
  readonly driver: ProviderDriver
  /** The dialect this attempt is addressed in: the account's own, translated or not. */
  readonly dialect: Dialect
  readonly url: URL
  /** The model name this account expects. Identity unless its alias map renames it. */
  readonly upstreamModel: string
  /**
   * The conversion this attempt runs, or null on the passthrough path — where there is deliberately
   * no translator at all, because a same-dialect body is opaque bytes with no schema behind them.
   */
  readonly translation: TranslationPair | null
  /**
   * How this attempt reaches the upstream. It lands on the `UsageRecord`, where it is what makes a
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

    // A translated request is addressed by the **account's** dialect, not the client's: the body is
    // converted, so it has to arrive at the endpoint that speaks the shape it was converted into.
    const dialect = egress.mode === "passthrough" ? egress.dialect : egress.to

    let url: URL
    try {
      url = upstreamUrl(egress.driver, account.driver, dialect)
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
      dialect,
      url,
      // The alias map is the operator's, applied by the driver, outbound-only, identity on a miss.
      upstreamModel: egress.driver.mapModelAlias(account.driver, candidate.upstreamModel),
      translation: egress.mode === "translate" ? egress.pair : null,
      egressMode: egress.mode,
    })
  }

  return { servable, rejection, endpointError }
}
