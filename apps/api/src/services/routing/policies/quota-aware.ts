/**
 * `quota-aware` — prefer the eligible account with the most remaining subscription headroom.
 *
 * Ranking by headroom requires a **continuous** signal: a gauge that reads a real percentage at
 * any point in the window. The SDK's `rate_limit_event` is not one — it is threshold-triggered,
 * populated only near the limit. It is the right input for the circuit breaker and useless for
 * ranking, and for most of a window every candidate would read `null`.
 *
 * So where the signal is absent this policy **degrades explicitly and detectably**. It never
 * quietly behaves like round-robin: the accounts it could not rank are named in a
 * `policy-degraded` note, and the accounts it did rank in a `quota-ranked` one. Without that,
 * a missing usage endpoint is invisible — and a missing usage endpoint is precisely the case an
 * operator has to act on, because it is when this policy silently stops working.
 */

import { continuousHeadroom } from "../quota"
import type { PolicyNote } from "../result"
import type { Candidate } from "../types"
import { accountIds, compareDeclared, type Policy, rotate, sortDeclared } from "./order"

export const quotaAware: Policy = ({ candidates, rotationCounter }) => {
  const ranked: { readonly candidate: Candidate; readonly headroom: number }[] = []
  const unranked: Candidate[] = []

  for (const candidate of candidates) {
    const headroom = continuousHeadroom(candidate.account)
    if (headroom === null) unranked.push(candidate)
    else ranked.push({ candidate, headroom })
  }

  // No continuous reading anywhere: every candidate ties at unknown and the tiebreak is an
  // arbitrary rotation. Say so — that is the whole difference from round-robin here.
  if (ranked.length === 0) {
    const ordered = rotate(sortDeclared(candidates), rotationCounter)
    return { ordered, notes: [degraded(accountIds(ordered))] }
  }

  ranked.sort(
    (left, right) =>
      right.headroom - left.headroom || compareDeclared(left.candidate, right.candidate),
  )
  const rotatedUnranked = rotate(sortDeclared(unranked), rotationCounter)

  const notes: PolicyNote[] = [
    {
      kind: "quota-ranked",
      accountIds: ranked.map((entry) => entry.candidate.account.id),
      unknownAccountIds: accountIds(rotatedUnranked),
    },
  ]
  // Partial coverage still degrades — for the accounts it could not read.
  if (rotatedUnranked.length > 0) notes.push(degraded(accountIds(rotatedUnranked)))

  return {
    ordered: [...ranked.map((entry) => entry.candidate), ...rotatedUnranked],
    notes,
  }
}

function degraded(ids: readonly string[]): PolicyNote {
  return {
    kind: "policy-degraded",
    from: "quota-aware",
    to: "round-robin",
    reason: "no-continuous-quota-signal",
    accountIds: ids,
  }
}
