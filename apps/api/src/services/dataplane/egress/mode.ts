import type { Dialect } from "@multi-ai-router/core"
import { type ClaudeSdkDriver, PROVIDER_REGISTRY, type ProviderDriver } from "../../../providers"
import { type TranslationPair, translationPair } from "../../translate"
import type { RoutableAccount, UpstreamOperation } from "../types"

/**
 * Which egress mode a (ingress dialect, selected Account) pair takes.
 *
 * There are three **transports** and the router takes the leftmost one that applies
 * (docs/idea/06-protocol-translation.md): **passthrough** when the dialects match,
 * **translate** when they differ and a conversion pair exists, **Agent-SDK re-synthesis** for
 * Claude subscriptions. A fourth decision, **estimate**, is not a transport at all: it is what a
 * subscription answers when the route asks for something the SDK does not expose.
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
 *
 * The `operation` then **narrows** that answer rather than forking it. A route that asks for
 * something other than a completion — a token count, an embedding — is passthrough or nothing: its
 * body has no faithful representation on an account whose provider states no such endpoint, and
 * embedding with a different model hands the client a vector it cannot tell from the one it asked
 * for. So the candidate is dropped by name here, and a pool where none can answer surfaces the
 * reason instead.
 *
 * **A token count is the one place the router answers for itself**, and only under two conditions
 * that are stated together, never separately: the scope holds **only Claude subscriptions**, and
 * the answer is **labelled**. A subscription cannot be asked — the Agent SDK states no token-count
 * call, and forging an `api.anthropic.com` request out of a subscription's credentials is
 * forbidden (docs/idea/11-anthropic-agent-sdk.md) — so a scope with nothing but subscriptions has
 * no provider to ask and would otherwise answer `503`. It answers with the router's own estimate
 * instead, carrying `estimated: true` so the number can never be mistaken for a measurement
 * (`count-estimate.ts`). An account that states a counting endpoint is still preferred by a wide
 * margin: the provider's own number is relayed byte for byte and the estimate is never reached.
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

/**
 * A Claude subscription asked to count tokens: it cannot, and the router can.
 *
 * A distinct decision rather than a rejection, because it is not a refusal. The Agent SDK states
 * no token-count call, so there is nothing upstream to address — but the request itself is
 * answerable, by the router's own estimate, and only when the scope holds nothing else.
 *
 * It carries no URL and no config directory: **no upstream is addressed on this path**, and no
 * subprocess is spawned. Nothing here touches an account, so nothing here can cool one down.
 */
export interface EstimateEgress {
  readonly mode: "estimate"
  readonly driver: ClaudeSdkDriver
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

export type EgressDecision =
  | PassthroughEgress
  | TranslateEgress
  | AgentSdkEgress
  | EstimateEgress
  | EgressRejection

/**
 * What a transport decision looks like before an operation narrows it.
 *
 * The estimate is **not** in here: it is only ever produced by narrowing a transport decision for
 * `count-tokens`, so the operation gates below see exactly the variants they can act on and the
 * compiler proves the estimate never reaches the embedding gate.
 */
export type TransportDecision =
  | PassthroughEgress
  | TranslateEgress
  | AgentSdkEgress
  | EgressRejection

export function resolveEgress(
  ingress: Dialect,
  account: RoutableAccount,
  operation: UpstreamOperation = "messages",
): EgressDecision {
  const decision = resolveTransport(ingress, account)
  if (operation === "count-tokens") return countable(decision)
  if (operation === "embeddings") return embeddable(decision)
  return decision
}

function resolveTransport(ingress: Dialect, account: RoutableAccount): TransportDecision {
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
 * Why an account whose provider states no counting endpoint is refused rather than estimated for.
 *
 * The estimate exists, and it is labelled — but it is a *fallback for a scope with no provider at
 * all*, not a substitute for one. Over an account whose provider states a counting endpoint, an
 * estimate would be budgeted against as though a provider had stated it, and the client could not
 * tell the two apart at the number.
 */
const NEVER_ESTIMATED =
  "and this router answers a token count with the provider's own number — an estimate of ours would be budgeted against as though a provider had stated it"

/**
 * Counting tokens is **passthrough, or the router's own labelled estimate**.
 *
 * `POST /v1/messages/count_tokens` asks a specific tokenizer what a specific prompt costs *on that
 * provider*, so the honest answer is the one the account itself returns. Wherever an account states
 * such an endpoint, that is what the client gets — relayed byte for byte, never re-derived.
 *
 * Two alternatives are not available at all:
 *
 *  - **Translating** it is meaningless. Two providers tokenize differently, so an OpenAI account's
 *    count is not an answer to the question the caller asked, and neither OpenAI dialect exposes a
 *    counting endpoint to ask in the first place. Such a candidate is refused by name.
 *  - **Estimating** it over a provider that *can* count is worse than failing. A fabricated
 *    integer is indistinguishable from a measured one at the client, which is the same objection
 *    that makes substituting a model forbidden (docs/idea/06-protocol-translation.md#counting-tokens).
 *
 * A Claude subscription is the exception, and it is a narrow one. The Agent SDK exposes no
 * token-count call, and the one thing this router will never do to get one is forge an
 * `api.anthropic.com` request out of a subscription's credentials
 * (docs/idea/11-anthropic-agent-sdk.md). So a subscription **cannot** count — but unlike an
 * OpenAI account it is not *refusing*: there is simply no provider in a subscription-only scope to
 * ask. That scope is answered by the router's own estimate, and the answer says so:
 * `estimated: true`, always, beside the number (`count-estimate.ts`).
 *
 * The refusal for the OpenAI family stays per candidate, so a mixed pool still serves the request
 * off whichever account *can* count — and a scope holding one Anthropic-dialect account beside
 * four subscriptions still counts off that account, never by estimate.
 */
function countable(decision: TransportDecision): EgressDecision {
  if (decision.mode === "passthrough" || decision.mode === "rejected") return decision

  if (decision.mode === "agent-sdk") {
    // A Claude subscription: no token-count call exists upstream, and none will be forged. The
    // router answers for itself, labelled — so this is a decision, not a refusal.
    return { mode: "estimate", driver: decision.driver }
  }

  return {
    mode: "rejected",
    reason: "unsupported-operation",
    message: `this account cannot count tokens: it speaks ${decision.to}, which states no token-count endpoint, ${NEVER_ESTIMATED}`,
  }
}

/** The two OpenAI dialects, which are one family for every operation that is not a completion. */
const OPENAI_DIALECTS: ReadonlySet<Dialect> = new Set<Dialect>(["openai-chat", "openai-responses"])

const NEVER_SUBSTITUTED =
  "and a vector from a different model is not a lesser answer but a wrong one — it would compare as noise against every embedding already in the caller's index"

/**
 * Embedding is an **OpenAI-family passthrough**, and both OpenAI dialects are that one family.
 *
 * `POST /v1/embeddings` carries a model and an `input` and nothing that distinguishes Chat
 * Completions from Responses, so `{baseUrl}/embeddings` is the same endpoint whichever chat surface
 * an Account is pinned to. Narrowing this to `openai-chat` alone would let an operator's choice of
 * *chat* primitive silently decide whether their key can embed — a routing rule nobody wrote down.
 *
 * Refused by name, before any upstream call:
 *
 *  - an **Anthropic-dialect** account. Anthropic publishes no embeddings API, so there is nothing
 *    below its base URL to address, and translating the request would mean answering with some
 *    other model's vectors — which is worse than failing, for the same reason estimating a token
 *    count is: embeddings are only comparable within the space the caller's index was built in.
 *  - a **Claude subscription**. The Agent SDK is a completion transport with no embeddings call,
 *    and the one thing this router will never do to reach an endpoint it lacks is forge an
 *    `api.anthropic.com` request out of a subscription's credentials
 *    (docs/idea/11-anthropic-agent-sdk.md).
 *
 * Per candidate, like the token count, so a pool holding one OpenAI key and four Claude
 * subscriptions still embeds — off the one account that can.
 */
function embeddable(decision: TransportDecision): EgressDecision {
  if (decision.mode === "rejected") return decision

  const dialect = decision.mode === "passthrough" ? decision.dialect : decision.to

  // A candidate pinned to the *other* OpenAI dialect is still a passthrough here: an embeddings body
  // has nothing in it for a chat translator to convert, and running one would rewrite the request
  // into a completion. The Agent-SDK mode is excluded by name rather than by its dialect, so an SDK
  // that later renders into an OpenAI dialect cannot fall into this branch silently.
  if (decision.mode !== "agent-sdk" && OPENAI_DIALECTS.has(dialect)) {
    return decision.mode === "passthrough"
      ? decision
      : { mode: "passthrough", driver: decision.driver, dialect }
  }

  const what =
    decision.mode === "agent-sdk"
      ? "is a Claude subscription served through the Claude Agent SDK, a completion transport that states no embeddings call"
      : `speaks ${dialect}, which states no embeddings endpoint`

  return {
    mode: "rejected",
    reason: "unsupported-operation",
    message: `this account cannot embed: it ${what}, ${NEVER_SUBSTITUTED}`,
  }
}

export { egressRejectionError } from "./rejection-error"
