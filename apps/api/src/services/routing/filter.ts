/**
 * Step 3 of the chain: of the in-scope accounts, keep the ones that can actually serve this
 * request.
 *
 * An account survives only if **all** of these hold: it is active, its breaker is not cooling
 * down, it is not `exhausted`, no quota window is spent, and it supports the requested model
 * after alias mapping. Filtering never falls back to "try it anyway" — an empty result is an
 * honest, specific error, and *which* error depends on why it is empty, which is exactly what
 * the rejection list carries.
 *
 * One exception, and it is a state rather than a relaxation: an account whose cooldown instant
 * has passed comes back as a **half-open probe**. It is eligible, and it is labeled, so the
 * caller can gate the probe and the policies can rank it behind healthy accounts.
 *
 * That gate is `health.probeHeldUntil`, and this is where its "exactly one" is enforced: the one
 * request holding it sees an eligible probe, and every other request sees the account dropped as
 * `probe-in-flight`. A recovering account takes one request, not the whole backlog that piled up
 * while it was down.
 */

import { resolveModel } from "./model"
import { DEFAULT_QUOTA_SPENT_THRESHOLD, findSpentWindow } from "./quota"
import type { RejectedCandidate } from "./result"
import type { Candidate, ScopedAccount, SelectionOptions } from "./types"

export interface FilterResult {
  readonly eligible: readonly Candidate[]
  readonly rejected: readonly RejectedCandidate[]
}

export type CandidateVerdict =
  | { readonly ok: true; readonly candidate: Candidate }
  | { readonly ok: false; readonly rejected: RejectedCandidate }

export function filterCandidates(
  members: readonly ScopedAccount[],
  model: string,
  now: Date,
  options: SelectionOptions = {},
): FilterResult {
  const eligible: Candidate[] = []
  const rejected: RejectedCandidate[] = []

  for (const member of members) {
    const verdict = evaluateCandidate(member, model, now, options)
    if (verdict.ok) eligible.push(verdict.candidate)
    else rejected.push(verdict.rejected)
  }

  return { eligible, rejected }
}

/** The single-account form. `binding.ts` uses it to ask whether a bound account is still usable. */
export function evaluateCandidate(
  member: ScopedAccount,
  model: string,
  now: Date,
  options: SelectionOptions = {},
): CandidateVerdict {
  const { account } = member
  const drop = (rejected: Omit<RejectedCandidate, "accountId" | "label">): CandidateVerdict => ({
    ok: false,
    rejected: { accountId: account.id, label: account.label, ...rejected },
  })

  if (account.status === "disabled") return drop({ reason: "disabled" })
  if (account.status === "needs_reauth") return drop({ reason: "needs-reauth" })
  // `exhausted` has no reset by definition — that absence is what distinguishes it from a cooldown.
  if (account.status === "exhausted") return drop({ reason: "exhausted" })

  const cooling = coolingDown(member, now)
  if (cooling) {
    return drop({
      reason: "cooling-down",
      ...(account.health.cooldownUntil !== undefined
        ? { resetsAt: account.health.cooldownUntil }
        : {}),
      ...(account.health.cooldownSource !== undefined
        ? { resetSource: account.health.cooldownSource }
        : {}),
    })
  }

  // The cooldown passed, so the breaker is half-open — but the one probe it earns is already out
  // with another request. Clock-recoverable and measured in milliseconds, so this renders as a
  // `429` carrying the hold's expiry: nothing here needs a human, and nothing here may pile 500
  // requests onto an account that has answered exactly none of them yet.
  const heldUntil = account.health.probeHeldUntil
  if (
    account.status === "cooling_down" &&
    heldUntil !== undefined &&
    heldUntil.getTime() > now.getTime()
  ) {
    // `estimated`: the instant is the router's own hold, not anything the provider said.
    return drop({ reason: "probe-in-flight", resetsAt: heldUntil, resetSource: "estimated" })
  }

  const spent = findSpentWindow(
    account,
    now,
    options.quotaSpentThreshold ?? DEFAULT_QUOTA_SPENT_THRESHOLD,
  )
  if (spent !== null) {
    return drop({
      reason: "quota-window-spent",
      window: spent.window,
      ...(spent.resetsAt !== undefined ? { resetsAt: spent.resetsAt } : {}),
      resetSource: spent.resetSource,
    })
  }

  const resolution = resolveModel(account, model)
  if (!resolution.supported) return drop({ reason: "model-unsupported" })

  return {
    ok: true,
    candidate: {
      ...member,
      upstreamModel: resolution.upstreamModel,
      halfOpen: account.status === "cooling_down",
    },
  }
}

/**
 * Still cooling when the breaker's reset instant is in the future. A `cooling_down` account with
 * no recorded instant stays out: there is nothing to say it came back, and inventing a number is
 * the one thing the reset rules forbid.
 */
function coolingDown(member: ScopedAccount, now: Date): boolean {
  const { status, health } = member.account
  const until = health.cooldownUntil
  if (until !== undefined && until.getTime() > now.getTime()) return true
  return status === "cooling_down" && until === undefined
}
