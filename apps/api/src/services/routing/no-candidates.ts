import { DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS } from "@multi-ai-router/core"
/**
 * When every candidate is unavailable, fail honestly and specifically.
 *
 * | Cause | Error | Status |
 * |---|---|---|
 * | Nothing configured, or nothing in the key's scope | `ScopeViolationError` | 403 |
 * | Everything cooling down / a window spent | `QuotaExhaustedError` + `Retry-After` | 429 |
 * | Everything out of credits | `CreditsExhaustedError` | 402 |
 * | Mixed causes | the soonest recoverable one — 429 if any account has a reset | — |
 * | Every account in scope serves other models | `ModelNotFoundError` | 404 |
 * | Anything else (disabled, needs re-auth, credential rejected) | `NoHealthyAccountError` | 503 |
 *
 * Never a generic `500`, and never a silent fallback outside the key's scope. The message names
 * the actual condition and the accounts it concerns — labels only, never credential material.
 */

import {
  CreditsExhaustedError,
  ModelNotFoundError,
  NoHealthyAccountError,
  QuotaExhaustedError,
  type ResetSource,
  type RouterError,
  type RouterErrorDetail,
  ScopeViolationError,
} from "@multi-ai-router/core"
import {
  accountWord,
  blockedCondition,
  describe,
  labels,
  poolNames,
  qualifier,
  recoverableCondition,
  remainder,
  unresolved,
  where,
} from "./no-candidates-wording"
import {
  type BindingDecision,
  type GroupDecision,
  RECOVERABLE_FILTER_REASONS,
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
export { DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS } from "@multi-ai-router/core"

export interface NoCandidatesInput {
  readonly scope: ScopeDiagnostics
  readonly groups: readonly GroupDecision[]
  readonly rejected: readonly RejectedCandidate[]
  readonly binding: BindingDecision
  readonly now: Date
  /** {@link DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS}. */
  readonly unknownResetRetryAfterSeconds?: number
  /** The client's own model name, echoed when nothing in scope serves it. */
  readonly model?: string
}

export function noCandidatesError(input: NoCandidatesInput): RouterError {
  const unknownFloor =
    input.unknownResetRetryAfterSeconds ?? DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS

  // A bound session whose account a clock will return: the honest 429 keeps the conversation
  // resumable. Resuming elsewhere is not an option — the other account never heard of the id.
  if (input.binding.state === "blocked") {
    const { accountId, reason, resetsAt } = input.binding
    return quotaError(
      `session is bound to account ${accountId}, which is ${blockedCondition(reason)}`,
      { resetsAt, resetSource: input.binding.resetSource },
      input.now,
      unknownFloor,
      {
        scope: "session",
        signal: reason,
        accounts: [{ accountId, state: reason, ...(resetsAt === undefined ? {} : { resetsAt }) }],
      },
    )
  }

  if (input.scope.inScopeAccountIds.length === 0) {
    return new ScopeViolationError(
      `no account is reachable through this key's scope (${input.scope.scope.kind})${unresolved(input.scope)}`,
      { detail: { signal: "no-account-in-scope" } },
    )
  }

  // Every member the request saw, by router id and reason: the sentence's "N of M" as data.
  const pool = (signal: string | undefined): RouterErrorDetail => ({
    ...(signal === undefined ? {} : { signal }),
    accounts: input.rejected.map((entry) => ({
      accountId: entry.accountId,
      state: entry.reason,
      ...(entry.resetsAt === undefined ? {} : { resetsAt: entry.resetsAt }),
    })),
    pools: poolNames(input.groups),
  })

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
    const earliest = earliestRecoverable(recoverable)
    return quotaError(
      `${recoverable.length} of ${total} ${accountWord(total)}${where(input.groups)} ${recoverable.length === 1 ? "is" : "are"} ${recoverableCondition(recoverable)} (${labels(recoverable)})${remainder(input.rejected, recoverable.length)}`,
      earliest,
      input.now,
      unknownFloor,
      pool(earliest.reason ?? recoverable[0]?.reason),
    )
  }

  if (exhausted.length > 0) {
    const scope = exhausted.length === total ? "all" : `${exhausted.length} of`
    return new CreditsExhaustedError(
      `${scope} ${total} ${accountWord(total)}${where(input.groups)} ${exhausted.length === 1 ? "is" : "are"} out of credits and ${exhausted.length === 1 ? "needs" : "need"} a top-up (${labels(exhausted)})${remainder(input.rejected, exhausted.length)}`,
      { detail: pool("exhausted") },
    )
  }

  // Every account in scope is healthy enough and simply serves other models: no clock and no
  // operator fixes that, the client named a model this key cannot reach. Say so in those words —
  // and with a `404`, the status both vendors give an unknown model: a `503` invited retries and
  // paged as a server fault for what is a client change (plan 101, 10.21).
  if (total > 0 && input.rejected.every((entry) => entry.reason === "model-unsupported")) {
    const named = input.model === undefined ? "this model" : `model "${input.model}"`
    return new ModelNotFoundError(
      `no account${where(input.groups)} serves ${named} — a client change (${total} ${accountWord(total)} in scope: ${labels(input.rejected)})`,
      { detail: pool("model-unsupported") },
    )
  }

  // Every recoverable and exhausted member returned above, so what is left — disabled, needs
  // re-auth, credential rejected, beside any that serve other models — waits on a person.
  return new NoHealthyAccountError(
    `no eligible account${where(input.groups)}: ${input.rejected.map(describe).join(", ")}`,
    { ...(total > 0 ? { wall: "human" } : {}), detail: pool(input.rejected[0]?.reason) },
  )
}

/** What the reset instant is, and how it was obtained. Carried together so neither renders alone. */
interface Reset {
  readonly resetsAt: Date | undefined
  readonly resetSource: ResetSource | undefined
  /** The filter reason of the account the instant belongs to. */
  readonly reason?: string
}

/** The rejection whose reset comes soonest — its provenance travels with the instant it names. */
function earliestRecoverable(entries: readonly RejectedCandidate[]): Reset {
  let earliest: RejectedCandidate | undefined
  for (const entry of entries) {
    if (entry.resetsAt === undefined) continue
    if (earliest?.resetsAt === undefined || entry.resetsAt.getTime() < earliest.resetsAt.getTime())
      earliest = entry
  }
  return {
    resetsAt: earliest?.resetsAt,
    resetSource: earliest?.resetSource,
    ...(earliest === undefined ? {} : { reason: earliest.reason }),
  }
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
  detail: RouterErrorDetail,
): QuotaExhaustedError {
  const { resetsAt, resetSource } = reset
  if (resetsAt === undefined) {
    return new QuotaExhaustedError(`${message}, reset time unknown`, {
      retryAfterSeconds: unknownFloorSeconds,
      detail,
    })
  }
  return new QuotaExhaustedError(
    `${message}, earliest reset ${resetsAt.toISOString()}${qualifier(resetSource)}`,
    {
      resetsAt,
      retryAfterSeconds: retryAfterSeconds(resetsAt, now),
      detail: { ...detail, resetSource: resetSource ?? "provider-reported" },
    },
  )
}

/** At least one second: a `Retry-After: 0` invites an immediate retry into the same wall. */
function retryAfterSeconds(resetsAt: Date, now: Date): number {
  return Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000))
}
