/**
 * When every candidate is unavailable, fail honestly and specifically.
 *
 * | Cause | Error | Status |
 * |---|---|---|
 * | Nothing configured, or nothing in the key's scope | `ScopeViolationError` | 403 |
 * | Everything cooling down / a window spent | `QuotaExhaustedError` + `Retry-After` | 429 |
 * | Everything out of credits | `CreditsExhaustedError` | 402 |
 * | Mixed causes | the soonest recoverable one — 429 if any account has a reset | — |
 * | Anything else (disabled, needs re-auth, model unsupported) | `NoHealthyAccountError` | 503 |
 *
 * Never a generic `500`, and never a silent fallback outside the key's scope. The message names
 * the actual condition and the accounts it concerns — labels only, never credential material.
 */

import {
  CreditsExhaustedError,
  NoHealthyAccountError,
  QuotaExhaustedError,
  type RouterError,
  ScopeViolationError,
} from "@multi-ai-router/core"
import { earliestReset } from "./quota"
import {
  type BindingDecision,
  type GroupDecision,
  RECOVERABLE_FILTER_REASONS,
  type RejectedCandidate,
  type ScopeDiagnostics,
} from "./result"

export interface NoCandidatesInput {
  readonly scope: ScopeDiagnostics
  readonly groups: readonly GroupDecision[]
  readonly rejected: readonly RejectedCandidate[]
  readonly binding: BindingDecision
  readonly now: Date
}

export function noCandidatesError(input: NoCandidatesInput): RouterError {
  // A bound session whose account is only cooling down: the honest 429 keeps the conversation
  // resumable. Resuming elsewhere is not an option — the other account never heard of the id.
  if (input.binding.state === "blocked") {
    return quotaError(
      `session is bound to account ${input.binding.accountId}, which is cooling down`,
      input.binding.resetsAt,
      input.now,
    )
  }

  if (input.scope.inScopeAccountIds.length === 0) {
    return new ScopeViolationError(
      `no account is reachable through this key's scope (${input.scope.scope.kind})${unresolved(input.scope)}`,
    )
  }

  const recoverable = input.rejected.filter((entry) =>
    RECOVERABLE_FILTER_REASONS.includes(entry.reason),
  )
  if (recoverable.length > 0) {
    const reset = earliestReset(recoverable.map((entry) => entry.resetsAt))
    return quotaError(
      `all ${input.rejected.length} ${accountWord(input.rejected.length)}${where(input.groups)} are rate limited or out of quota (${labels(recoverable)})`,
      reset,
      input.now,
    )
  }

  const exhausted = input.rejected.filter((entry) => entry.reason === "exhausted")
  if (exhausted.length > 0) {
    return new CreditsExhaustedError(
      `all ${input.rejected.length} ${accountWord(input.rejected.length)}${where(input.groups)} are out of credits and need a top-up (${labels(exhausted)})`,
    )
  }

  return new NoHealthyAccountError(
    `no eligible account${where(input.groups)}: ${input.rejected.map(describe).join(", ")}`,
  )
}

function quotaError(message: string, resetsAt: Date | undefined, now: Date): QuotaExhaustedError {
  if (resetsAt === undefined) return new QuotaExhaustedError(message)
  return new QuotaExhaustedError(`${message}, earliest reset ${resetsAt.toISOString()}`, {
    resetsAt,
    retryAfterSeconds: retryAfterSeconds(resetsAt, now),
  })
}

/** At least one second: a `Retry-After: 0` invites an immediate retry into the same wall. */
function retryAfterSeconds(resetsAt: Date, now: Date): number {
  return Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000))
}

function where(groups: readonly GroupDecision[]): string {
  const named = groups
    .map((group) => group.poolName)
    .filter((name): name is string => name !== null)
  if (named.length === 0) return ""
  if (named.length === 1) return ` in pool ${named[0]}`
  return ` in pools ${named.join(", ")}`
}

function unresolved(scope: ScopeDiagnostics): string {
  const count = scope.unresolvedTargetIds.length
  return count === 0
    ? ""
    : ` (${count} scope ${count === 1 ? "target" : "targets"} no longer exist)`
}

function labels(entries: readonly RejectedCandidate[]): string {
  return entries.map((entry) => entry.label).join(", ")
}

function describe(entry: RejectedCandidate): string {
  return `${entry.label} ${entry.reason}`
}

function accountWord(count: number): string {
  return count === 1 ? "account" : "accounts"
}
