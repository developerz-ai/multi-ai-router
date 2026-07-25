import {
  type Dialect,
  NoHealthyAccountError,
  type RouterError,
  TranslationError,
} from "@multi-ai-router/core"
import { type ClaudeSdkDriver, PROVIDER_REGISTRY, type ProviderDriver } from "../../../providers"
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
 * The Agent-SDK mode is the exception with no fast path at all: the SDK yields its own message
 * objects, so **even a same-dialect subscription request is a re-synthesis** and this decision never
 * reports it as a passthrough (docs/idea/11-anthropic-agent-sdk.md §6). What it does reuse is the
 * translation registry — the SDK is rendered into Anthropic Messages once, and any other ingress
 * dialect is then served by the same pair an `anthropic-api` account would have used.
 *
 * A dialect pair with no translator is refused here explicitly, named, and before any upstream call
 * — never degraded into a lossy approximation. Every crossing between the three HTTP dialects has
 * one today, and a pair added later becomes servable by adding an entry to
 * `services/translate/registry.ts` and nothing else.
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

/**
 * A Claude subscription: `query()` against the Account's own `CLAUDE_CONFIG_DIR`, with the SDK's
 * output re-synthesized rather than relayed.
 *
 * Shaped like `TranslateEgress` on purpose. `to` is the dialect the SDK is rendered into — always
 * the driver's own, never the Account's pinned surface — and `pair` is the reuse of the ordinary
 * translation registry for every other ingress dialect, which is what keeps this from becoming a
 * second renderer per dialect (docs/idea/11-anthropic-agent-sdk.md §6).
 */
export interface AgentSdkEgress {
  readonly mode: "agent-sdk"
  readonly driver: ClaudeSdkDriver
  /** The dialect the client spoke. */
  readonly from: Dialect
  /** What the SDK's output is re-synthesized into, and what the request is converted toward. */
  readonly to: Dialect
  /** The conversion, or null when the client already speaks the dialect the SDK renders. */
  readonly pair: TranslationPair | null
}

export type EgressRejectionReason =
  /** Dialects differ and this build has no conversion pair for them. */
  | "no-translator"
  /** The provider is declared in the domain but has no driver yet. */
  | "unimplemented"

export interface EgressRejection {
  readonly mode: "rejected"
  readonly reason: EgressRejectionReason
  readonly message: string
}

export type EgressDecision = PassthroughEgress | TranslateEgress | AgentSdkEgress | EgressRejection

export function resolveEgress(ingress: Dialect, account: RoutableAccount): EgressDecision {
  const support = PROVIDER_REGISTRY[account.driver.provider]

  if (support.transport === "agent-sdk") {
    const to = support.driver.dialect
    // No passthrough branch, deliberately: there is nothing to proxy, so a matching dialect means
    // "no conversion needed", not "forward the bytes".
    if (ingress === to) {
      return { mode: "agent-sdk", driver: support.driver, from: ingress, to, pair: null }
    }
    const pair = translationPair(ingress, to)
    if (pair === null) return noTranslator(ingress, to)
    return { mode: "agent-sdk", driver: support.driver, from: ingress, to, pair }
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
  if (pair === null) return noTranslator(ingress, egressDialect)

  return { mode: "translate", driver: support.driver, from: ingress, to: egressDialect, pair }
}

function noTranslator(ingress: Dialect, egress: Dialect): EgressRejection {
  return {
    mode: "rejected",
    reason: "no-translator",
    message: `a ${ingress} request cannot be served by a ${egress} account: this build implements no ${ingress} to ${egress} translation`,
  }
}

/**
 * The client-facing failure when no candidate could be served.
 *
 * A missing translator is a `400` — the request as sent has no faithful representation on any
 * account this key can reach, which is a fact about the request rather than about capacity, and a
 * caller can act on it by calling a different ingress path. An unimplemented provider is a `503`:
 * the caller did nothing wrong and there is nothing they can change, so answering `400` would send
 * them looking in the wrong place.
 */
export function egressRejectionError(rejection: EgressRejection): RouterError {
  return rejection.reason === "no-translator"
    ? new TranslationError(rejection.message)
    : new NoHealthyAccountError(rejection.message)
}
