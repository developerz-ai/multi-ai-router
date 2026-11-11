import type { Dialect } from "@multi-ai-router/core"
import { PROVIDER_REGISTRY } from "../../providers"
import type { Candidate, SelectionDecision } from "../routing"
import { resolveEgress } from "./egress/mode"
import type { CandidatePlan } from "./plan"
import {
  accountLookup,
  type RoutableAccount,
  type RoutingCatalog,
  type UpstreamOperation,
} from "./types"
import { type UnservableOutcome, unservableOutcome } from "./unservable"

/**
 * Whether an account **could have served** this request's operation, health aside.
 *
 * This is the question the empty chain asks about an account selection held back: its verdict is
 * the answer only if the account would have served the request had it been healthy. An OpenAI
 * account asked to count tokens never could — it states no counting endpoint — so its cooldown
 * says nothing about this request, and the shape gap is the truth.
 *
 * A Claude subscription is the harder case, because **the estimate is not a serving capability**:
 * the Agent SDK states no token-count call, so a subscription can never be asked for a count, awake
 * or cooling. Yet its health still decides the answer when the scope holds nothing but
 * subscriptions — there the estimate *is* this scope's answer, and the subscription's cooldown is
 * what stands between the client and it, so the honest reply is the `429` a clock recovers.
 *
 * Beside any account that states a counting endpoint of its own, the estimate is not the answer at
 * all: the scope has a provider-shaped gap, the request is refused by name, and a subscription's
 * cooldown is not the reason.
 */
function couldHaveServed(input: {
  readonly account: RoutableAccount
  readonly operation: UpstreamOperation
  readonly ingress: Dialect
  /** Whether the router's own estimate is this scope's answer. */
  readonly estimateIsTheAnswer: boolean
}): boolean {
  const mode = resolveEgress(input.ingress, input.account, input.operation).mode
  // A subscription is never addressed upstream for a count: the Agent SDK states no such call, and
  // the router will not forge one. Its health is a verdict on the account, not on the operation.
  if (mode === "estimate") return input.estimateIsTheAnswer
  // Every other account is judged by the egress gate: one that states the endpoint could have
  // served it, and one that does not never could, awake or cooling.
  return mode !== "rejected"
}

/**
 * Whether an account is a Claude subscription — served by the Agent SDK, not over HTTP.
 *
 * Asked of the provider registry rather than of a provider id: "is this account a subscription" is
 * the transport seam, and a comparison on the id would spread a fact the registry already owns.
 */
function isSubscription(account: RoutableAccount): boolean {
  return PROVIDER_REGISTRY[account.driver.provider].transport === "agent-sdk"
}

/**
 * Whether every account the router could have picked for this request is a Claude subscription.
 *
 * The candidates, not the whole scope: an account the operator switched off is not in the running,
 * and the same question the plan asks of them (`plan.estimable`) is asked of the accounts that
 * survived selection. A scope whose live members are all subscriptions has no provider to ask, so
 * the router's own estimate is its answer; a scope holding one OpenAI account beside them has a
 * provider-shaped gap, the estimate is not its answer, and a subscription's cooldown is not the
 * reason the request fails.
 */
function everyCandidateIsASubscription(
  candidates: readonly Candidate[],
  accountOf: (id: string) => RoutableAccount | undefined,
): boolean {
  return candidates.every((candidate) => {
    const account = accountOf(candidate.account.id)
    return account !== undefined && isSubscription(account)
  })
}

/**
 * The empty chain's answer: selection found candidates, planning could serve none of them. Off the
 * served path — this second catalog read happens only once the chain is empty.
 */
export function emptyChainOutcome(input: {
  readonly plan: CandidatePlan
  readonly decision: SelectionDecision
  readonly candidates: readonly Candidate[]
  readonly catalog: RoutingCatalog
  readonly operation: UpstreamOperation
  readonly ingress: Dialect
  readonly now: Date
}): UnservableOutcome {
  const accountOf = accountLookup(input.catalog)
  // Whether the router's own estimate is this scope's answer, decided once per empty chain.
  const estimateIsTheAnswer = everyCandidateIsASubscription(input.candidates, accountOf)
  return unservableOutcome({
    plan: input.plan,
    decision: input.decision,
    capable: (accountId) => {
      const account = accountOf(accountId)
      if (account === undefined) return false
      return couldHaveServed({
        account,
        operation: input.operation,
        ingress: input.ingress,
        estimateIsTheAnswer,
      })
    },
    now: input.now,
  })
}
