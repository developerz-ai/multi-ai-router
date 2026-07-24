import {
  type Dialect,
  NoHealthyAccountError,
  type RouterError,
  TranslationError,
} from "@multi-ai-router/core"
import { PROVIDER_REGISTRY, type ProviderDriver } from "../../../providers"
import type { RoutableAccount } from "../types"

/**
 * Which egress mode a (ingress dialect, selected Account) pair takes.
 *
 * There are three modes and the router takes the leftmost one that applies
 * (docs/idea/06-protocol-translation.md): **passthrough** when the dialects match,
 * **translate** when they differ, **Agent-SDK re-synthesis** for Claude subscriptions.
 *
 * **This build implements passthrough only.** Translation is a separate deliverable and the
 * Agent-SDK path is another; both are refused here explicitly, named, and before any upstream call
 * — never degraded into a lossy approximation. The seam is exactly this function: when
 * `services/translate/**` lands, a `translate` variant joins the union and nothing above changes.
 */

export interface PassthroughEgress {
  readonly mode: "passthrough"
  readonly driver: ProviderDriver
  readonly dialect: Dialect
}

export type EgressRejectionReason =
  /** Dialects differ. A faithful conversion is required and is not implemented here. */
  | "cross-dialect"
  /** Claude subscription: served by `query()`, not by any HTTP driver. Nothing to proxy. */
  | "agent-sdk"
  /** The provider is declared in the domain but has no driver yet. */
  | "unimplemented"

export interface EgressRejection {
  readonly mode: "rejected"
  readonly reason: EgressRejectionReason
  readonly message: string
}

export type EgressDecision = PassthroughEgress | EgressRejection

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
  if (egressDialect !== ingress) {
    return {
      mode: "rejected",
      reason: "cross-dialect",
      message: `a ${ingress} request cannot be served by a ${egressDialect} account without protocol translation, which this build does not implement`,
    }
  }

  return { mode: "passthrough", driver: support.driver, dialect: egressDialect }
}

/**
 * The client-facing failure when no candidate could be served.
 *
 * Cross-dialect is a `400` — the request as sent has no faithful representation upstream, which is
 * a fact about the request. The other two are a `503`: the caller did nothing wrong and there is
 * nothing they can change, so answering `400` would send them looking in the wrong place.
 */
export function egressRejectionError(rejection: EgressRejection): RouterError {
  return rejection.reason === "cross-dialect"
    ? new TranslationError(rejection.message)
    : new NoHealthyAccountError(rejection.message)
}
