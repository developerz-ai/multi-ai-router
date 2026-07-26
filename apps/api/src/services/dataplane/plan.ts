import {
  type Dialect,
  type EgressMode,
  isRouterError,
  type RouterError,
} from "@multi-ai-router/core"
import type { ClaudeSdkDriver, ProviderDriver } from "../../providers"
import type { Candidate } from "../routing"
import type { TranslationPair } from "../translate"
import { upstreamCountTokensUrl, upstreamUrl } from "./egress/endpoint"
import { type EgressRejection, resolveEgress } from "./egress/mode"
import type { RoutableAccount, RoutingCatalog, UpstreamOperation } from "./types"

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
 *
 * The `operation` narrows the same walk rather than forking it: a `count-tokens` request plans over
 * exactly the candidates that can count, and one that cannot is dropped here like any other
 * unservable candidate — so a pool holding one Anthropic account and four Claude subscriptions
 * still answers, off the one account that can.
 *
 * It is also free to mix **transports**. `kind` is the seam: an HTTP candidate carries the URL it is
 * addressed at, a Claude subscription carries the `CLAUDE_CONFIG_DIR` its subprocess runs against,
 * and nothing else in the chain has to ask which is which. Resolving both here means the same class
 * of operator misconfiguration — no base URL, no config directory — is caught at the same point, by
 * the driver that owns the answer, before a request is spent on it.
 */

/** What both transports carry. `kind` below decides what each carries on top of it. */
interface ServablePlan {
  readonly candidate: Candidate
  readonly account: RoutableAccount
  /**
   * The dialect this attempt speaks: the account's own on the HTTP path, translated or not, and the
   * one the SDK is re-synthesized into on the Agent-SDK path.
   */
  readonly dialect: Dialect
  /** The model name this account expects. Identity unless its alias map renames it. */
  readonly upstreamModel: string
  /**
   * The conversion this attempt runs, or null when the client already speaks the dialect this
   * attempt answers in. On the passthrough path that null is load-bearing: there is deliberately no
   * translator at all, because a same-dialect body is opaque bytes with no schema behind them. On
   * the Agent-SDK path it only means no conversion is needed — the body is read either way.
   */
  readonly translation: TranslationPair | null
  /**
   * How this attempt reaches the upstream. It lands on the `UsageRecord`, where it is what makes a
   * `router_overhead_seconds` regression attributable to a path rather than to the router at large.
   */
  readonly egressMode: EgressMode
}

/** Addressed over HTTP: a URL, a credential, and a body forwarded to it. */
export interface HttpServableCandidate extends ServablePlan {
  readonly kind: "http"
  readonly driver: ProviderDriver
  readonly url: URL
}

/**
 * Served by the Claude Agent SDK. There is no URL and no credential the router holds: the config
 * directory is where the subscription's own credentials live, and the SDK is the only thing that
 * reads them (docs/idea/11-anthropic-agent-sdk.md §3).
 */
export interface SdkServableCandidate extends ServablePlan {
  readonly kind: "sdk"
  readonly driver: ClaudeSdkDriver
  readonly configDir: string
}

export type ServableCandidate = HttpServableCandidate | SdkServableCandidate

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
  operation: UpstreamOperation = "messages",
): CandidatePlan {
  const accounts = new Map(catalog.accounts().map((account) => [account.id, account]))
  const servable: ServableCandidate[] = []
  let rejection: EgressRejection | null = null
  let endpointError: RouterError | null = null

  for (const candidate of candidates) {
    const account = accounts.get(candidate.account.id)
    if (account === undefined) continue

    const egress = resolveEgress(ingress, account, operation)
    if (egress.mode === "rejected") {
      rejection ??= egress
      continue
    }

    // A converted request takes the **account's** dialect, not the client's: the body is rewritten,
    // so it has to arrive in the shape it was rewritten into.
    const plan: ServablePlan = {
      candidate,
      account,
      dialect: egress.mode === "passthrough" ? egress.dialect : egress.to,
      // The alias map is the operator's, applied by the driver, outbound-only, identity on a miss.
      upstreamModel: egress.driver.mapModelAlias(account.driver, candidate.upstreamModel),
      translation: egress.mode === "passthrough" ? null : egress.pair,
      egressMode: egress.mode,
    }

    try {
      servable.push(
        egress.mode === "agent-sdk"
          ? {
              ...plan,
              kind: "sdk",
              driver: egress.driver,
              configDir: egress.driver.resolveConfigDir(account),
            }
          : {
              ...plan,
              kind: "http",
              driver: egress.driver,
              // Only a passthrough candidate reaches here on the count-tokens path — `resolveEgress`
              // refuses every other mode — so the account is known to speak the one dialect that
              // states the endpoint.
              url:
                operation === "count-tokens"
                  ? upstreamCountTokensUrl(egress.driver, account.driver)
                  : upstreamUrl(egress.driver, account.driver, plan.dialect),
            },
      )
    } catch (error) {
      // Both resolvers throw a `RouterError` naming the account. One unusable endpoint — or one
      // subscription account with no config directory — must not take the rest of the chain down.
      if (isRouterError(error)) {
        endpointError ??= error
        continue
      }
      throw error
    }
  }

  return { servable, rejection, endpointError }
}
