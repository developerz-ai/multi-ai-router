import {
  type Dialect,
  NoHealthyAccountError,
  type RouterError,
  TranslationError,
} from "@multi-ai-router/core"
import { type ClaudeSdkDriver, PROVIDER_REGISTRY, type ProviderDriver } from "../../../providers"
import { type TranslationPair, translationPair } from "../../translate"
import type { RoutableAccount, UpstreamOperation } from "../types"

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
  /** The account can serve inference, but not the operation this route performs. */
  | "unsupported-operation"

export interface EgressRejection {
  readonly mode: "rejected"
  readonly reason: EgressRejectionReason
  readonly message: string
}

export type EgressDecision = PassthroughEgress | TranslateEgress | AgentSdkEgress | EgressRejection

export function resolveEgress(
  ingress: Dialect,
  account: RoutableAccount,
  operation: UpstreamOperation = "messages",
): EgressDecision {
  const decision = resolveTransport(ingress, account)
  return operation === "count-tokens" ? countable(decision) : decision
}

function resolveTransport(ingress: Dialect, account: RoutableAccount): EgressDecision {
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

const NEVER_ESTIMATED =
  "and this router answers a token count with the provider's own number or with nothing at all — an estimate of ours would be budgeted against as though a provider had stated it"

/**
 * Counting tokens is **passthrough or nothing**.
 *
 * `POST /v1/messages/count_tokens` asks a specific tokenizer what a specific prompt costs *on that
 * provider*, so the only honest answer is the one the account itself returns. Neither alternative
 * survives contact with what the number is used for — a client compacting its context at a
 * threshold:
 *
 *  - **Translating** it is meaningless. Two providers tokenize differently, so an OpenAI account's
 *    count is not an answer to the question the caller asked, and neither OpenAI dialect exposes a
 *    counting endpoint to ask in the first place.
 *  - **Estimating** it is worse than failing. A fabricated integer is indistinguishable from a
 *    measured one at the client, which is the same objection that makes substituting a model
 *    forbidden (docs/idea/06-protocol-translation.md#counting-tokens).
 *
 * A Claude subscription lands here too: the Agent SDK exposes no token-count call, and the one
 * thing this router will never do to get one is forge an `api.anthropic.com` request out of a
 * subscription's credentials (docs/idea/11-anthropic-agent-sdk.md).
 *
 * The refusal is per candidate, so a mixed pool still serves the request off whichever account
 * *can* count. Only when none can does it surface — as a `503`, because the caller's request is
 * fine and it is the operator who would fix this by adding an Anthropic-dialect account.
 */
function countable(decision: EgressDecision): EgressDecision {
  if (decision.mode === "passthrough" || decision.mode === "rejected") return decision

  const what =
    decision.mode === "agent-sdk"
      ? "is a Claude subscription served through the Claude Agent SDK, which exposes no token-count call"
      : `speaks ${decision.to}, which states no token-count endpoint`

  return {
    mode: "rejected",
    reason: "unsupported-operation",
    message: `this account cannot count tokens: it ${what}, ${NEVER_ESTIMATED}`,
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
 *
 * An unsupported *operation* is a `503` for that second reason and not the first, even though it
 * also refuses a request before any upstream call. A `count_tokens` body is a perfectly valid
 * Anthropic request and there is no other ingress path to send it down — what is missing is an
 * Anthropic-dialect account in this key's scope, which only the operator can add.
 */
export function egressRejectionError(rejection: EgressRejection): RouterError {
  return rejection.reason === "no-translator"
    ? new TranslationError(rejection.message)
    : new NoHealthyAccountError(rejection.message)
}
