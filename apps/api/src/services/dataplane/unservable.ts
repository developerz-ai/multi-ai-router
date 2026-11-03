import { NoHealthyAccountError, type RouterError } from "@multi-ai-router/core"
import {
  noCandidatesError,
  RECOVERABLE_FILTER_REASONS,
  type RejectedCandidate,
  type SelectionDecision,
} from "../routing"
import { egressRejectionError } from "./egress/mode"
import type { CandidatePlan } from "./plan"

/**
 * What to answer when routing found candidates but **none of them could be planned** — pure, so the
 * precedence rule it encodes is testable without a catalog, a store, or a clock.
 *
 * Selection and planning ask different questions and neither sees the other's answer. Selection
 * drops an account because of its *health* ("cooling down until 14:32"); planning drops one because
 * of its *shape* ("speaks openai-chat, which states no token-count endpoint"). Take them in the
 * wrong order and the router reports the wrong thing:
 *
 *     pool = [ anthropic-api (cooling down, 2 min), openai-api (active) ]
 *     POST /v1/messages/count_tokens
 *
 * Selection drops the Anthropic account and returns the OpenAI one, which planning then drops as
 * unable to count — and the plan's rejection is all that is left, so the client gets
 * `503 "no account can count tokens"` with no `Retry-After`. Both halves of that are wrong. The
 * operator is told to add an Anthropic-dialect account they already have, and a client is handed a
 * permanent-looking refusal for a condition a clock fixes in two minutes — which is exactly the
 * conflation non-negotiable 7 forbids.
 *
 * So the verdict on an account that **could** have served this operation outranks the one on an
 * account that never could. `capable` is what decides "could have": the same egress gate planning
 * used, asked about an account selection had already filtered. Only a health verdict a clock or a
 * human resolves takes over — `cooling_down`, a spent window, a probe in flight, `exhausted`. A
 * capable account dropped as `disabled` or `model-unsupported` leaves the plan's own message
 * standing, because that message is the more useful of the two.
 *
 * **Three answers, in this order**, and the order is the whole point:
 *
 *  1. **A health verdict on an account that could have served the request.** `429` with a
 *     `Retry-After` for a rate-limited or spent window, `402` for exhausted credits. Never an
 *     estimate over a clock-recoverable condition: the operator is one coffee away from a working
 *     account, and telling the client "no account can do this" is a lie that outlives the coffee.
 *  2. **The router's own labelled estimate**, when the scope holds nothing but Claude
 *     subscriptions. The Agent SDK states no token-count call, so there is no provider in such a
 *     scope to ask; the router answers with its own number and says so (`count-estimate.ts`).
 *  3. **The named refusal** — the plan's own message, which says which operation no account in
 *     this scope could perform and why.
 *
 * Nothing here runs on a served request: this is only reached once the chain is known to be empty.
 */

const NO_CANDIDATE = "No candidate account can serve this request"

/** Health verdicts that a clock or a human resolves — the ones worth surfacing over a shape gap. */
function held(entry: RejectedCandidate): boolean {
  return entry.reason === "exhausted" || RECOVERABLE_FILTER_REASONS.includes(entry.reason)
}

export interface UnservableInput {
  readonly plan: CandidatePlan
  readonly decision: SelectionDecision
  /**
   * Whether the account behind an id could have served **this request's operation**, health aside.
   * Injected rather than resolved here so this stays a pure function over a decision.
   */
  readonly capable: (accountId: string) => boolean
  readonly now: Date
}

/**
 * What an empty chain is answered with.
 *
 * `estimate` is not a failure and carries no error: it is the router's own answer, and the caller
 * renders it as a successful response rather than raising anything.
 */
export type UnservableOutcome =
  | { readonly kind: "refusal"; readonly error: RouterError }
  | { readonly kind: "estimate" }

/**
 * The refusal for a chain that could not be planned.
 *
 * The refusal half of {@link unservableOutcome}, on its own: the health verdict when there is one,
 * and the plan's own message otherwise. A caller that can only fail uses this; the router's own
 * path asks for the decision, because a subscription-only scope has a third answer and this
 * function has no way to name it.
 */
export function unservableError(input: UnservableInput): RouterError {
  const health = healthVerdict(input)
  if (health !== null) return health
  return planRefusal(input.plan)
}

/**
 * The three-way decision for a chain that could not be planned.
 *
 * The order below is the order in {@link UnservableOutcome}'s docblock, and it is load-bearing:
 * the health verdict is taken first because a condition a clock resolves must never be reported as
 * a permanent gap, and the estimate is taken before the refusal because a scope holding only
 * Claude subscriptions can be answered — just not by a provider.
 */
export function unservableOutcome(input: UnservableInput): UnservableOutcome {
  const health = healthVerdict(input)
  if (health !== null) return { kind: "refusal", error: health }
  // A scope of nothing but subscriptions: the router answers for itself, labelled.
  if (input.plan.estimable === true) return { kind: "estimate" }
  return { kind: "refusal", error: planRefusal(input.plan) }
}

/**
 * The verdict on an account that could have served this operation and was held back by its health.
 *
 * Null when there is none — which covers both "nothing was held back" and "what was held back
 * could never have served this operation anyway" (an OpenAI account cannot count, so its being
 * rate-limited says nothing about this request).
 */
function healthVerdict(input: UnservableInput): RouterError | null {
  const blocked = input.decision.rejected.filter(
    (entry) => held(entry) && input.capable(entry.accountId),
  )
  if (blocked.length === 0) return null

  // One builder for both paths: the 429/402/`Retry-After` rules live in `no-candidates.ts` and a
  // second copy here could disagree with it about what `cooling_down` owes a client.
  return noCandidatesError({
    scope: input.decision.scope,
    groups: input.decision.groups,
    rejected: blocked,
    binding: input.decision.binding,
    now: input.now,
  })
}

/** The plan's own reason, when there is one: the operation gap, or an endpoint that would not resolve. */
function planRefusal(plan: CandidatePlan): RouterError {
  if (plan.rejection !== null) return egressRejectionError(plan.rejection)
  return plan.endpointError ?? new NoHealthyAccountError(NO_CANDIDATE)
}
