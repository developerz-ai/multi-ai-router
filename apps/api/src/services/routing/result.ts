/**
 * The outputs of routing selection.
 *
 * Selection returns the ordered candidates *and why* — which policy ran, whether a session
 * binding was honored, which accounts were dropped and for what reason. The admin UI and the
 * structured logs both read this, and it is what makes the unit tests assert a decision rather
 * than a bare pick.
 */

import type {
  QuotaWindowKind,
  ResetSource,
  RouterError,
  RoutingPolicy,
} from "@multi-ai-router/core"
import type { Candidate, KeyScopeSnapshot } from "./types"

/** Why an in-scope account did not survive filtering. One reason per account: the first that hit. */
export type FilterReason =
  | "disabled"
  | "needs-reauth"
  | "exhausted"
  | "cooling-down"
  /** Its cooldown passed, but another request is already spending the one probe it earns. */
  | "probe-in-flight"
  | "quota-window-spent"
  | "model-unsupported"

/** The clock-recoverable subset of {@link FilterReason} — the only reasons a binding may block on. */
export type RecoverableFilterReason = "cooling-down" | "probe-in-flight" | "quota-window-spent"

/** Filter reasons a clock alone recovers from. Everything else needs a human or a client change. */
export const RECOVERABLE_FILTER_REASONS: readonly FilterReason[] = [
  "cooling-down",
  // A probe is in flight and settles in milliseconds; the account is either back or cooling again
  // the instant it does. Nothing here needs a human, so it must not read as though it did.
  "probe-in-flight",
  "quota-window-spent",
]

export function isRecoverableFilterReason(reason: FilterReason): reason is RecoverableFilterReason {
  return RECOVERABLE_FILTER_REASONS.includes(reason)
}

export interface RejectedCandidate {
  readonly accountId: string
  readonly label: string
  readonly reason: FilterReason
  /** When it comes back, when that is known. Absent on `exhausted` — by definition. */
  readonly resetsAt?: Date
  readonly resetSource?: ResetSource
  /** The window that blocked it, when the reason is `quota-window-spent`. */
  readonly window?: QuotaWindowKind
}

/** What a policy wants the operator and the logs to know about the ordering it produced. */
export type PolicyNote =
  | { readonly kind: "binding-pinned"; readonly accountId: string }
  | { readonly kind: "half-open-demoted"; readonly accountIds: readonly string[] }
  | { readonly kind: "overflow-engaged"; readonly accountId: string }
  | { readonly kind: "weights-absent"; readonly accountIds: readonly string[] }
  | {
      /**
       * The policy could not do its job with the signals present and fell back. Explicit and
       * detectable: `quota-aware` without a continuous quota signal is round-robin, and silently
       * behaving like round-robin is exactly what the spec forbids.
       */
      readonly kind: "policy-degraded"
      readonly from: RoutingPolicy
      readonly to: RoutingPolicy
      readonly reason: "no-continuous-quota-signal"
      readonly accountIds: readonly string[]
    }
  | {
      /** Ranked on a real continuous reading — the only signal `quota-aware` may rank on. */
      readonly kind: "quota-ranked"
      readonly accountIds: readonly string[]
      /** Candidates with no continuous reading, appended after the ranked ones. */
      readonly unknownAccountIds: readonly string[]
    }

/** Why a binding could not be honored. Mirrors the table in `02-domain-model.md`. */
export type BindingInvalidationReason =
  | "account-missing"
  | "out-of-scope"
  | "exhausted"
  | "needs-reauth"
  | "disabled"
  | "model-unsupported"
  | "quota-window-spent"
  | "cooling-down"
  | "probe-in-flight"

export type BindingDecision =
  | { readonly state: "none" }
  /** The bound account is eligible. It is the choice, for any policy. */
  | { readonly state: "honored"; readonly accountId: string }
  /**
   * The bound account is out for a reason a clock recovers. The binding is *kept* — a clock will
   * fix it and the conversation is still resumable — and the request fails honestly rather than
   * resuming somewhere it cannot be resumed. `reason` and `resetSource` travel with the instant
   * because the 429 rendered from this must name the actual condition and must not present a
   * guessed reset as a fact (`types.ts`, `AccountHealth.cooldownSource`).
   */
  | {
      readonly state: "blocked"
      readonly accountId: string
      readonly reason: RecoverableFilterReason
      readonly resetsAt?: Date
      readonly resetSource?: ResetSource
    }
  /**
   * The binding is dropped, never moved. The next request starts a fresh upstream session on a
   * new account and the loss of prior turns is surfaced, never silently truncated.
   */
  | {
      readonly state: "invalidated"
      readonly accountId: string
      readonly reason: BindingInvalidationReason
    }

export interface ScopeDiagnostics {
  readonly scope: KeyScopeSnapshot
  /** Accounts the scope admitted, before any filtering. */
  readonly inScopeAccountIds: readonly string[]
  /** Named scope targets that resolved to nothing — a deleted pool, a removed account. */
  readonly unresolvedTargetIds: readonly string[]
}

export interface GroupDecision {
  readonly poolId: string | null
  readonly poolName: string | null
  readonly policy: RoutingPolicy
  /** Ordered account ids this group contributed, head first. */
  readonly ordered: readonly string[]
  readonly notes: readonly PolicyNote[]
}

export interface SelectionDecision {
  readonly scope: ScopeDiagnostics
  readonly groups: readonly GroupDecision[]
  readonly rejected: readonly RejectedCandidate[]
  readonly binding: BindingDecision
  /** True when a pool's member of last resort was engaged. Marked on every `UsageRecord`. */
  readonly usedOverflow: boolean
}

export interface SelectionSuccess {
  readonly ok: true
  /** The failover order, head first. Never empty. */
  readonly candidates: readonly Candidate[]
  readonly decision: SelectionDecision
}

export interface SelectionFailure {
  readonly ok: false
  /** A `RouterError` subclass whose status names the actual cause. Never a generic 500. */
  readonly error: RouterError
  readonly decision: SelectionDecision
}

export type SelectionResult = SelectionSuccess | SelectionFailure
