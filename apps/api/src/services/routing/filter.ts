/**
 * Step 3 of the chain: of the in-scope accounts, keep the ones that can actually serve this
 * request.
 *
 * An account survives only if **all** of these hold: it is active, its breaker is not cooling
 * down, it is not `exhausted`, no quota window is spent, and it supports the requested model
 * after alias mapping — by its declared list, else its provider's model family. Filtering never falls back to "try it anyway" — an empty result is an
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
import { hasRecoveryPermit, recoveryAllowsQuota, recoveryIsGated } from "./recovery-filter"
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

  // Before every clock-recoverable reason, and on purpose: an account that cannot serve this model
  // at all must never read as "cooling down" or "settling a probe". That reading is a `429` and,
  // for a bound session, a *kept* binding — a Kimi conversation pinned to a Claude subscription,
  // told to wait for an account that will never serve it (prod, 2026-10-04). Unsupported is the
  // permanent fact; it invalidates the binding and names a client change.
  const resolution = resolveModel(account, model)
  if (!resolution.supported) return drop({ reason: "model-unsupported" })

  const threshold = options.quotaSpentThreshold ?? DEFAULT_QUOTA_SPENT_THRESHOLD
  const spent = findSpentWindow(account, now, threshold)
  const spentDrop =
    spent !== null && !recoveryAllowsQuota(account, now, threshold)
      ? drop({
          reason: "quota-window-spent",
          window: spent.window,
          ...(spent.resetsAt !== undefined ? { resetsAt: spent.resetsAt } : {}),
          resetSource: spent.resetSource,
        })
      : null
  const coolingDrop = drop({
    reason:
      account.health.cooldownReason === "credential-rejected"
        ? "credential-rejected"
        : "cooling-down",
    ...(account.health.cooldownUntil !== undefined
      ? { resetsAt: account.health.cooldownUntil }
      : {}),
    ...(account.health.cooldownSource !== undefined
      ? { resetSource: account.health.cooldownSource }
      : {}),
  })

  // A clock the provider itself reported outranks the router's own holds. Neither the recovery
  // gate nor the breaker's probe hold can bring this account back before that instant, so naming
  // them instead reads as "<1s, estimated" on an account that is out for two days — a misleading
  // `429`, a `cooldown-expired` recovery hint and so a wasted probe every gate cycle, and a bound
  // session that waits on the hold instead of moving (prod, 2026-10-06). Only provider-reported
  // clocks: an estimated or unknown one is exactly what a recovery probe exists to re-test.
  if (providerReportedCooldown(member, now)) return coolingDrop
  if (spentDrop !== null && spent?.resetSource === "provider-reported") return spentDrop

  const permit = hasRecoveryPermit(account)
  if (recoveryIsGated(account) && !permit) {
    return drop({
      reason: "probe-in-flight",
      resetsAt: account.recovery?.retryAt ?? account.recovery?.nextAllowedAt,
      resetSource: "estimated",
    })
  }
  if (coolingDown(member, now) && (!permit || account.health.cooldownUntil !== undefined)) {
    return coolingDrop
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

  if (spentDrop !== null) return spentDrop

  return {
    ok: true,
    candidate: {
      ...member,
      upstreamModel: resolution.upstreamModel,
      halfOpen: account.status === "cooling_down" || permit,
      ...(permit ? { recoveryPermit: true } : {}),
      // An identity entry (`opus -> opus`) renames nothing, so it is not a reason to rank behind.
      aliased: resolution.upstreamModel !== model,
    },
  }
}

/**
 * Still cooling when the breaker's reset instant is in the future. A `cooling_down` account with
 * no recorded instant stays out: there is nothing to say it came back, and inventing a number is
 * the one thing the reset rules forbid.
 */
function providerReportedCooldown(member: ScopedAccount, now: Date): boolean {
  const { health } = member.account
  return (
    health.cooldownSource === "provider-reported" &&
    health.cooldownReason !== "credential-rejected" &&
    health.cooldownUntil !== undefined &&
    health.cooldownUntil.getTime() > now.getTime()
  )
}

function coolingDown(member: ScopedAccount, now: Date): boolean {
  const { status, health } = member.account
  const until = health.cooldownUntil
  if (until !== undefined && until.getTime() > now.getTime()) return true
  return status === "cooling_down" && until === undefined
}
