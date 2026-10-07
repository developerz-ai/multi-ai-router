/**
 * The policy registry, and the two rules that hold for **every** policy.
 *
 * 1. **The binding wins over the policy.** If a live session already has an account, that account
 *    is the choice — for any policy. `round-robin`, `weighted`, `least-used`, and `quota-aware`
 *    are only safe on a Claude subscription pool because they run through here: they choose
 *    solely for a session with no binding, or one whose binding was invalidated. There is no
 *    operation that carries a session from one account to another.
 * 2. **A half-open probe ranks behind a healthy account** — except the holder of a designated
 *    recovery permit, which ranks ahead. An account whose cooldown just expired is eligible, but
 *    it is a probe, not a preference. A permit is different: the coordinator reserved exactly one
 *    attempt for it, nothing but a request settles it, and ranked last it expired unused every
 *    cycle while the account sat out of rotation (prod, 2026-10-07: 38 permits, zero attempts).
 *    A failed permit attempt fails over before any byte reaches the client.
 * 3. **An alias rename ranks behind the real thing.** When some candidates serve the requested
 *    name natively and others only reach it through their alias map (`claude-opus-5 -> glm-5.2`),
 *    the aliased ones are failover after every native one — healthy or probe. A key whose scope
 *    holds only aliased accounts still routes through them; nothing is dropped, only ordered.
 *
 * Running a policy module directly bypasses both. Callers use {@link runPolicy}.
 */

import type { RoutingPolicy } from "@multi-ai-router/core"
import type { BindingDecision, PolicyNote } from "../result"
import type { Candidate } from "../types"
import { leastUsed } from "./least-used"
import { accountIds, nativeFirst, type Policy, type PolicyInput, type PolicyOutput } from "./order"
import { priorityFailover } from "./priority-failover"
import { quotaAware } from "./quota-aware"
import { roundRobin } from "./round-robin"
import { sticky } from "./sticky"
import { weighted } from "./weighted"

export const POLICIES: Readonly<Record<RoutingPolicy, Policy>> = {
  sticky,
  "round-robin": roundRobin,
  weighted,
  "least-used": leastUsed,
  "priority-failover": priorityFailover,
  "quota-aware": quotaAware,
}

export function runPolicy(
  policy: RoutingPolicy,
  input: PolicyInput,
  binding: BindingDecision = { state: "none" },
): PolicyOutput {
  const chosen = POLICIES[policy]
  const raw = chosen(input)
  const demoted = demoteHalfOpen(raw.ordered)
  const promoted = promoteRecoveryPermit(demoted.ordered)
  const deferred = deferAliased(promoted.ordered)
  const pinned = pinBinding(deferred.ordered, binding)

  return {
    ordered: pinned.ordered,
    notes: [...raw.notes, ...demoted.notes, ...promoted.notes, ...deferred.notes, ...pinned.notes],
  }
}

interface Adjustment {
  readonly ordered: readonly Candidate[]
  readonly notes: readonly PolicyNote[]
}

/** Healthy accounts first, probes after, each keeping the policy's relative order. */
function demoteHalfOpen(ordered: readonly Candidate[]): Adjustment {
  const healthy = ordered.filter((candidate) => !candidate.halfOpen)
  if (healthy.length === ordered.length) return { ordered, notes: [] }

  const probes = ordered.filter((candidate) => candidate.halfOpen)
  return {
    ordered: [...healthy, ...probes],
    notes: [{ kind: "half-open-demoted", accountIds: accountIds(probes) }],
  }
}

/** Permit holders first, everyone else after, each keeping the order it already had. */
function promoteRecoveryPermit(ordered: readonly Candidate[]): Adjustment {
  const holders = ordered.filter((candidate) => candidate.recoveryPermit === true)
  if (holders.length === 0) return { ordered, notes: [] }

  const rest = ordered.filter((candidate) => candidate.recoveryPermit !== true)
  return {
    ordered: [...holders, ...rest],
    notes: [{ kind: "recovery-promoted", accountIds: accountIds(holders) }],
  }
}

/** Native accounts first, alias-only accounts after. Runs after probe demotion: native wins. */
function deferAliased(ordered: readonly Candidate[]): Adjustment {
  const split = nativeFirst(ordered)
  if (split.deferred.length === 0) return { ordered, notes: [] }
  return {
    ordered: split.ordered,
    notes: [{ kind: "aliased-deferred", accountIds: accountIds(split.deferred) }],
  }
}

/**
 * Moves the bound account to the head. The binding is authoritative state, not a preference:
 * only the storing account can resume its session id, so no ordering may put another account
 * ahead of it. A binding that is not in the list was already invalidated upstream of here.
 */
function pinBinding(ordered: readonly Candidate[], binding: BindingDecision): Adjustment {
  if (binding.state !== "honored") return { ordered, notes: [] }

  const index = ordered.findIndex((candidate) => candidate.account.id === binding.accountId)
  const bound = index < 0 ? undefined : ordered[index]
  if (bound === undefined) return { ordered, notes: [] }

  return {
    ordered: [bound, ...ordered.slice(0, index), ...ordered.slice(index + 1)],
    notes: [{ kind: "binding-pinned", accountId: binding.accountId }],
  }
}

export type { Policy, PolicyInput, PolicyOptions, PolicyOutput } from "./order"
export { leastUsed, priorityFailover, quotaAware, roundRobin, sticky, weighted }
