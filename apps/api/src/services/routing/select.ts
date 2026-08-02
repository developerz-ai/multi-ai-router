/**
 * The selection chain, steps 1-4 of `05-routing-and-failover.md`:
 *
 *     resolve scope -> intersect with pool membership -> filter -> policy -> ordered candidates
 *
 * A pure function over an injected snapshot. No clock read, no store, no lock, no I/O — build a
 * snapshot, call this, assert the decision.
 *
 * Two things this returns that a bare pick would not: the **ordered** candidate list, because
 * failover walks it, and the **decision**, because the admin UI and the logs both have to answer
 * "why that account?" — which policy ran, whether a binding was honored, who was dropped and for
 * what reason.
 */

import { decideBinding } from "./binding"
import { evaluateCandidate, filterCandidates } from "./filter"
import { noCandidatesError } from "./no-candidates"
import { runPolicy } from "./policies"
import type { GroupDecision, PolicyNote, RejectedCandidate, SelectionResult } from "./result"
import { resolveScope } from "./scope"
import type {
  Candidate,
  RoutingSnapshot,
  ScopeGroup,
  SelectionOptions,
  SelectionRequest,
} from "./types"

export function selectAccounts(
  snapshot: RoutingSnapshot,
  request: SelectionRequest,
  options: SelectionOptions = {},
): SelectionResult {
  const { groups: scopeGroups, diagnostics } = resolveScope(snapshot, request, options)
  const binding = decideBinding(
    snapshot,
    scopeGroups,
    request.binding?.accountId,
    request.model,
    options,
  )

  const groups: GroupDecision[] = []
  const rejected = new Map<string, RejectedCandidate>()
  const ordered: Candidate[] = []
  const seen = new Set<string>()
  let usedOverflow = false

  for (const group of scopeGroups) {
    const resolved = resolveGroup(group, request, snapshot, options)
    for (const entry of resolved.rejected) {
      if (!rejected.has(entry.accountId)) rejected.set(entry.accountId, entry)
    }
    usedOverflow = usedOverflow || resolved.usedOverflow

    const policed =
      resolved.eligible.length === 0
        ? { ordered: [] as readonly Candidate[], notes: [] as readonly PolicyNote[] }
        : runPolicy(
            group.policy,
            {
              candidates: resolved.eligible,
              sessionKey: request.sessionKey,
              rotationCounter: group.rotationCounter,
              options,
            },
            binding,
          )

    // Each attempt is a distinct account: an account sitting in two of the key's pools is one
    // candidate, at its first position.
    for (const candidate of policed.ordered) {
      if (seen.has(candidate.account.id)) continue
      seen.add(candidate.account.id)
      ordered.push(candidate)
    }

    groups.push({
      poolId: group.poolId,
      poolName: group.poolName,
      policy: group.policy,
      ordered: policed.ordered.map((candidate) => candidate.account.id),
      notes: [...policed.notes, ...resolved.notes],
    })
  }

  const decision = {
    scope: diagnostics,
    groups,
    rejected: [...rejected.values()],
    binding,
    usedOverflow,
  }

  // The policy runs per pool, so a binding honored inside the second pool still outranks the
  // first pool's head: the binding is truth, the ordering is preference.
  const candidates = binding.state === "honored" ? hoist(ordered, binding.accountId) : ordered

  if (binding.state === "blocked" || candidates.length === 0) {
    return {
      ok: false,
      error: noCandidatesError({
        ...decision,
        now: snapshot.now,
        ...(options.unknownResetRetryAfterSeconds === undefined
          ? {}
          : { unknownResetRetryAfterSeconds: options.unknownResetRetryAfterSeconds }),
      }),
      decision,
    }
  }

  return { ok: true, candidates, decision }
}

interface ResolvedGroup {
  readonly eligible: readonly Candidate[]
  readonly rejected: readonly RejectedCandidate[]
  readonly notes: readonly PolicyNote[]
  readonly usedOverflow: boolean
}

function resolveGroup(
  group: ScopeGroup,
  request: SelectionRequest,
  snapshot: RoutingSnapshot,
  options: SelectionOptions,
): ResolvedGroup {
  const filtered = filterCandidates(group.members, request.model, snapshot.now, options)
  if (filtered.eligible.length > 0 || group.overflow === null) {
    return { ...filtered, notes: [], usedOverflow: false }
  }

  // Overflow: a member of last resort, invisible to the policy until the primary set is empty
  // after filtering. Not on a single 429, not on latency — and still inside the key's scope.
  const verdict = evaluateCandidate(group.overflow, request.model, snapshot.now, options)
  if (!verdict.ok) {
    return {
      eligible: [],
      rejected: [...filtered.rejected, verdict.rejected],
      notes: [],
      usedOverflow: false,
    }
  }

  return {
    eligible: [verdict.candidate],
    rejected: filtered.rejected,
    notes: [{ kind: "overflow-engaged", accountId: verdict.candidate.account.id }],
    usedOverflow: true,
  }
}

function hoist(candidates: readonly Candidate[], accountId: string): readonly Candidate[] {
  const index = candidates.findIndex((candidate) => candidate.account.id === accountId)
  const bound = index < 0 ? undefined : candidates[index]
  if (bound === undefined) return candidates
  return [bound, ...candidates.slice(0, index), ...candidates.slice(index + 1)]
}
