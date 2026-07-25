import {
  type Dialect,
  NoHealthyAccountError,
  type RouterError,
  TranslationError,
} from "@multi-ai-router/core"
import { PROVIDER_REGISTRY, type ProviderDriver } from "../../../providers"
import { type TranslationPair, translationPair } from "../../translate"
import type { RoutableAccount } from "../types"

/**
 * Which egress mode a (ingress dialect, selected Account) pair takes.
 *
 * There are three modes and the router takes the leftmost one that applies
 * (docs/idea/06-protocol-translation.md): **passthrough** when the dialects match,
 * **translate** when they differ and a conversion pair exists, **Agent-SDK re-synthesis** for
 * Claude subscriptions.
 *
 * **Passthrough is always preferred**, because it has zero translation loss: a new upstream
 * feature, a content block type nobody here has heard of, a beta flag — all survive a passthrough
 * and none survive a translation we did not write. So the dialect test comes first and the registry
 * lookup only happens when the dialects genuinely differ.
 *
 * The Agent-SDK path is a separate deliverable and is refused here explicitly, named, and before
 * any upstream call — never degraded into a lossy approximation. So is a dialect pair with no
 * translator: the `openai-responses` rows of the matrix are exactly that today, and they become
 * servable by adding an entry to `services/translate/registry.ts` and nothing else.
 */

export interface PassthroughEgress {
  readonly mode: "passthrough"
  readonly driver: ProviderDriver
  readonly dialect: Dialect
}

export interface TranslateEgress {
  readonly mode: "translate"
  readonly driver: ProviderDriver
  /** The dialect the client spoke. */
  readonly from: Dialect
  /** The dialect the account speaks, and the one this request is addressed and converted into. */
  readonly to: Dialect
  /** The conversion, resolved here so "servable" means "a translator exists", not "one might". */
  readonly pair: TranslationPair
}

export type EgressRejectionReason =
  /** Dialects differ and this build has no conversion pair for them. */
  | "no-translator"
  /** Claude subscription: served by `query()`, not by any HTTP driver. Nothing to proxy. */
  | "agent-sdk"
  /** The provider is declared in the domain but has no driver yet. */
  | "unimplemented"

export interface EgressRejection {
  readonly mode: "rejected"
  readonly reason: EgressRejectionReason
  readonly message: string
}

export type EgressDecision = PassthroughEgress | TranslateEgress | EgressRejection

export function resolveEgress(ingress: Dialect, account: RoutableAccount): EgressDecision {
  const support = PROVIDER_REGISTRY[account.driver.provider]

  if (support.transport === "agent-sdk") {
    return {
      mode: "rejected",
      reason: "agent-sdk",
      message: `account ${account.id} is a Claude subscription: it is served through the Agent SDK, which this build does not implement`,
    }
  }

  if (support.transport === "unimplemented") {
    return {
      mode: "rejected",
      reason: "unimplemented",
      message: `provider ${account.driver.provider} has no driver: ${support.reason}`,
    }
  }

  const egressDialect = support.driver.resolveDialect(account.driver)
  if (egressDialect === ingress) {
    return { mode: "passthrough", driver: support.driver, dialect: egressDialect }
  }

  const pair = translationPair(ingress, egressDialect)
  if (pair === null) {
    return {
      mode: "rejected",
      reason: "no-translator",
      message: `a ${ingress} request cannot be served by a ${egressDialect} account: this build implements no ${ingress} to ${egressDialect} translation`,
    }
  }

  return { mode: "translate", driver: support.driver, from: ingress, to: egressDialect, pair }
}

/**
 * The client-facing failure when no candidate could be served.
 *
 * A missing translator is a `400` — the request as sent has no faithful representation on any
 * account this key can reach, which is a fact about the request rather than about capacity, and a
 * caller can act on it by calling a different ingress path. The other two are a `503`: the caller
 * did nothing wrong and there is nothing they can change, so answering `400` would send them
 * looking in the wrong place.
 */
export function egressRejectionError(rejection: EgressRejection): RouterError {
  return rejection.reason === "no-translator"
    ? new TranslationError(rejection.message)
    : new NoHealthyAccountError(rejection.message)
}
