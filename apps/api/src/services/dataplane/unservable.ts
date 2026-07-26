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

export function unservableError(input: UnservableInput): RouterError {
  const blocked = input.decision.rejected.filter(
    (entry) => held(entry) && input.capable(entry.accountId),
  )

  if (blocked.length > 0) {
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

  if (input.plan.rejection !== null) return egressRejectionError(input.plan.rejection)
  return input.plan.endpointError ?? new NoHealthyAccountError(NO_CANDIDATE)
}
