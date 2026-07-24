/**
 * `least-used` — the candidate carrying the lowest current load first.
 *
 * Which measure is the default is **DEFERRED** in `05-routing-and-failover.md`. The router picks
 * in-flight requests, because it is the one signal that exists for every provider and reacts
 * immediately, and uses recent token spend as the tiebreak. `leastUsedMeasure` swaps the two.
 *
 * Reactive, so it can oscillate under rapid churn — which on a Claude subscription pool would
 * move a session mid-conversation on a load blip. That is why `runPolicy` pins an existing
 * binding ahead of this ordering; this policy only ever chooses for an unbound session.
 */

import type { Candidate } from "../types"
import { compareDeclared, type Policy, type PolicyOptions } from "./order"

type Measure = NonNullable<PolicyOptions["leastUsedMeasure"]>

export const leastUsed: Policy = ({ candidates, options }) => {
  const measure: Measure = options.leastUsedMeasure ?? "in-flight"

  const ordered = [...candidates].sort((left, right) => {
    const primary = load(left, measure) - load(right, measure)
    if (primary !== 0) return primary
    const secondary = load(left, other(measure)) - load(right, other(measure))
    if (secondary !== 0) return secondary
    return compareDeclared(left, right)
  })

  return { ordered, notes: [] }
}

function load(candidate: Candidate, measure: Measure): number {
  return measure === "in-flight"
    ? candidate.account.health.inFlight
    : candidate.account.health.recentTokens
}

function other(measure: Measure): Measure {
  return measure === "in-flight" ? "recent-tokens" : "in-flight"
}
