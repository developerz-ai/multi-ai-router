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
  type ResetSource,
  type RouterError,
  ScopeViolationError,
} from "@multi-ai-router/core"
import {
  type BindingDecision,
  type GroupDecision,
  RECOVERABLE_FILTER_REASONS,
  type RecoverableFilterReason,
  type RejectedCandidate,
  type ScopeDiagnostics,
} from "./result"

/**
 * `cooling_down` demands a `Retry-After` (non-negotiable 7) even for the one state `filter.ts`
 * admits with no recorded instant — a legacy or hand-set row that never went through the
 * breaker's own `trip()`. No clock is scheduled to clear that state, so the floor is a pause,
 * not a countdown: the old floor of one second (the breaker's first backoff step) had every
 * waiting client retrying once a second, forever, against a condition no timer resolves.
 * Operator-configurable through {@link NoCandidatesInput.unknownResetRetryAfterSeconds}
 * (non-negotiable 11: every interval is config).
 */
export const DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS = 30

export interface NoCandidatesInput {
  readonly scope: ScopeDiagnostics
  readonly groups: readonly GroupDecision[]
  readonly rejected: readonly RejectedCandidate[]
  readonly binding: BindingDecision
  readonly now: Date
  /** {@link DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS}. */
  readonly unknownResetRetryAfterSeconds?: number
}

export function noCandidatesError(input: NoCandidatesInput): RouterError {
  const unknownFloor =
    input.unknownResetRetryAfterSeconds ?? DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS

  // A bound session whose account a clock will return: the honest 429 keeps the conversation
  // resumable. Resuming elsewhere is not an option — the other account never heard of the id.
  if (input.binding.state === "blocked") {
    return quotaError(
      `session is bound to account ${input.binding.accountId}, which is ${blockedCondition(input.binding.reason)}`,
      { resetsAt: input.binding.resetsAt, resetSource: input.binding.resetSource },
      input.now,
      unknownFloor,
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
  const exhausted = input.rejected.filter((entry) => entry.reason === "exhausted")
  const total = input.rejected.length

  // Recoverable outranks exhausted (the doc table's "mixed causes" row: the soonest recoverable
  // one, 429 if any account has a reset) — but the message must count and label only the accounts
  // it is actually describing, and it must account for **every** rejected member. "2 of 3 are rate
  // limited (a, b)" with the third silently `needs_reauth` read as though one account were healthy
  // (#88); the ones a human or a client change would fix are named in their own clause instead.
  if (recoverable.length > 0) {
    return quotaError(
      `${recoverable.length} of ${total} ${accountWord(total)}${where(input.groups)} ${recoverable.length === 1 ? "is" : "are"} rate limited or out of quota (${labels(recoverable)})${remainder(input.rejected, recoverable.length)}`,
      earliestRecoverable(recoverable),
      input.now,
      unknownFloor,
    )
  }

  if (exhausted.length > 0) {
    const scope = exhausted.length === total ? "all" : `${exhausted.length} of`
    return new CreditsExhaustedError(
      `${scope} ${total} ${accountWord(total)}${where(input.groups)} ${exhausted.length === 1 ? "is" : "are"} out of credits and ${exhausted.length === 1 ? "needs" : "need"} a top-up (${labels(exhausted)})${remainder(input.rejected, exhausted.length)}`,
    )
  }

  return new NoHealthyAccountError(
    `no eligible account${where(input.groups)}: ${input.rejected.map(describe).join(", ")}`,
  )
}

/**
 * The rejected members the leading clause did not describe, each group named by what fixes it.
 * `described` is how many the leading clause covered; the clauses here cover the rest, so the
 * numbers in one message always add up to the pool the request saw.
 */
function remainder(rejected: readonly RejectedCandidate[], described: number): string {
  if (described === rejected.length) return ""
  const clauses: string[] = []
  const recoverable = rejected.filter((entry) => RECOVERABLE_FILTER_REASONS.includes(entry.reason))
  const exhausted = rejected.filter((entry) => entry.reason === "exhausted")
  const human = rejected.filter(
    (entry) => entry.reason === "disabled" || entry.reason === "needs-reauth",
  )
  const unsupported = rejected.filter((entry) => entry.reason === "model-unsupported")

  // The leading clause is the recoverable group when it is non-empty, else the exhausted one.
  if (recoverable.length > 0 && exhausted.length > 0) {
    clauses.push(
      `${exhausted.length} more ${accountWord(exhausted.length)} out of credits and ${exhausted.length === 1 ? "needs" : "need"} a top-up (${labels(exhausted)})`,
    )
  }
  if (human.length > 0) {
    clauses.push(
      `${human.length} more ${human.length === 1 ? "needs" : "need"} a human (${human.map(describe).join(", ")})`,
    )
  }
  if (unsupported.length > 0) {
    clauses.push(
      `${unsupported.length} more ${unsupported.length === 1 ? "does" : "do"} not serve this model — a client change (${labels(unsupported)})`,
    )
  }
  return clauses.length === 0 ? "" : `; ${clauses.join("; ")}`
}

/** What the reset instant is, and how it was obtained. Carried together so neither renders alone. */
interface Reset {
  readonly resetsAt: Date | undefined
  readonly resetSource: ResetSource | undefined
}

/** The rejection whose reset comes soonest — its provenance travels with the instant it names. */
function earliestRecoverable(entries: readonly RejectedCandidate[]): Reset {
  let earliest: RejectedCandidate | undefined
  for (const entry of entries) {
    if (entry.resetsAt === undefined) continue
    if (earliest?.resetsAt === undefined || entry.resetsAt.getTime() < earliest.resetsAt.getTime())
      earliest = entry
  }
  return { resetsAt: earliest?.resetsAt, resetSource: earliest?.resetSource }
}

/** The condition the message names — `cooling down` for every blocked reason misnamed two of them. */
function blockedCondition(reason: RecoverableFilterReason): string {
  if (reason === "quota-window-spent") return "out of quota until its window resets"
  if (reason === "probe-in-flight") return "settling a recovery probe"
  return "cooling down"
}

/**
 * `resetsAt` absent means the reason is recoverable but no instant is known — still `cooling_down`
 * ≠ `exhausted` (non-negotiable 7), so this still renders `429` with a `Retry-After`, just an
 * honest floor instead of a fabricated instant. A present instant renders with its provenance
 * whenever it was not the provider's own word: a guessed reset presented as fact is worse than no
 * reset at all (`types.ts`, `AccountHealth.cooldownSource`).
 */
function quotaError(
  message: string,
  reset: Reset,
  now: Date,
  unknownFloorSeconds: number,
): QuotaExhaustedError {
  const { resetsAt, resetSource } = reset
  if (resetsAt === undefined) {
    return new QuotaExhaustedError(`${message}, reset time unknown`, {
      retryAfterSeconds: unknownFloorSeconds,
    })
  }
  const qualifier =
    resetSource === undefined || resetSource === "provider-reported" ? "" : ` (${resetSource})`
  return new QuotaExhaustedError(
    `${message}, earliest reset ${resetsAt.toISOString()}${qualifier}`,
    {
      resetsAt,
      retryAfterSeconds: retryAfterSeconds(resetsAt, now),
    },
  )
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

/** `kimi needs re-auth`, `ollama disabled` — the label and the condition, in the operator's words. */
function describe(entry: RejectedCandidate): string {
  return `${entry.label} ${entry.reason === "needs-reauth" ? "needs re-auth" : entry.reason}`
}

function accountWord(count: number): string {
  return count === 1 ? "account" : "accounts"
}
