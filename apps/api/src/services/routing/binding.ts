/**
 * The Session -> Account binding decision.
 *
 * On the Agent-SDK path the binding is persisted, authoritative state: an SDK session id is
 * resumable **only** where its transcript is, so this is not a routing preference a policy may
 * overrule. Four outcomes, and none of them moves the row — a turn that runs elsewhere carries the
 * transcript itself (`providers/claude-sdk/session-carry.ts`) and re-points the row once answered:
 *
 * | Outcome | Meaning |
 * |---|---|
 * | `honored` | The bound account is eligible. It is the choice, whatever the policy would prefer. |
 * | `blocked` | The account is out for a reason a clock recovers — cooling down, a spent quota window, or a probe already in flight. The binding is **kept** — a clock will fix it and the conversation stays resumable — and the request fails honestly with a `429` rather than resuming where it cannot be resumed. |
 * | `invalidated` | No clock returns this account (or `rebind` will not wait for it). The turn is placed elsewhere and carries the transcript there; a carry that cannot happen starts fresh and surfaces the loss, never silently truncated. |
 * | `none` | The session has no binding; the policy places it. |
 *
 * `boundAccountCoolingDown: "rebind"` converts `blocked` into `invalidated` for callers that
 * would rather restart the conversation than wait. It is opt-in because the honest `429` is what
 * keeps the conversation intact. It applies to `cooling-down` and `quota-window-spent` only:
 * `probe-in-flight` is the router's own ~30-second hold, already settling inside another request,
 * and dropping a resumable conversation over it would trade seconds for the whole history.
 *
 * `carryBoundSessions` (on whenever the SDK session carry is) changes the arithmetic behind
 * `blocked`: the wait existed to keep the transcript resumable, and a carry takes the transcript
 * to whichever account serves the turn. So a `blocked` binding becomes `invalidated` — same
 * reason, every recoverable one including `probe-in-flight` — whenever another candidate is
 * eligible ({@link carryBlockedBinding}). With no alternative it stays `blocked`: the binding is
 * kept and the `429` carries the bound account's own reset.
 */

import { evaluateCandidate } from "./filter"
import {
  type BindingDecision,
  type BindingInvalidationReason,
  type FilterReason,
  isRecoverableFilterReason,
} from "./result"
import type { RoutingSnapshot, ScopedAccount, ScopeGroup, SelectionOptions } from "./types"

export function decideBinding(
  snapshot: RoutingSnapshot,
  groups: readonly ScopeGroup[],
  boundAccountId: string | undefined,
  model: string,
  options: SelectionOptions = {},
): BindingDecision {
  if (boundAccountId === undefined) return { state: "none" }

  const member = findInScope(groups, boundAccountId)
  if (member === null) {
    const known = snapshot.accounts.some((account) => account.id === boundAccountId)
    // Scope always wins: a binding can never reach an account the key may not use.
    return {
      state: "invalidated",
      accountId: boundAccountId,
      reason: known ? "out-of-scope" : "account-missing",
    }
  }

  const verdict = evaluateCandidate(member, model, snapshot.now, options)
  if (verdict.ok) return { state: "honored", accountId: boundAccountId }

  const { reason, resetsAt, resetSource } = verdict.rejected
  // A window that refills on a clock keeps its binding; anything else drops it. `rebind` opts out
  // of the wait — except for `probe-in-flight`, the shortest clock of all: a probe already in
  // flight on the bound account is back or cooling again within one request, so dropping a
  // resumable conversation over it would be absurd, whatever the operator configured.
  if (
    isRecoverableFilterReason(reason) &&
    ((options.boundAccountCoolingDown ?? "fail") === "fail" || reason === "probe-in-flight")
  ) {
    return {
      state: "blocked",
      accountId: boundAccountId,
      reason,
      ...(resetsAt ? { resetsAt } : {}),
      ...(resetSource ? { resetSource } : {}),
    }
  }

  return { state: "invalidated", accountId: boundAccountId, reason: invalidationFor(reason) }
}

/**
 * Applied once filtering knows whether anything else can serve. A pure rewrite of the decision:
 * the policies pin only an `honored` binding, so ordering is identical either way.
 */
export function carryBlockedBinding(
  binding: BindingDecision,
  hasAlternative: boolean,
  options: SelectionOptions = {},
): BindingDecision {
  if (binding.state !== "blocked" || !hasAlternative || options.carryBoundSessions !== true) {
    return binding
  }
  return { state: "invalidated", accountId: binding.accountId, reason: binding.reason }
}

function invalidationFor(reason: FilterReason): BindingInvalidationReason {
  return reason
}

function findInScope(groups: readonly ScopeGroup[], accountId: string): ScopedAccount | null {
  for (const group of groups) {
    for (const member of group.members) {
      if (member.account.id === accountId) return member
    }
    if (group.overflow !== null && group.overflow.account.id === accountId) return group.overflow
  }
  return null
}
