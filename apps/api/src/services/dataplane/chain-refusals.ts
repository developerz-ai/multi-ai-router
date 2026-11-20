import { NoHealthyAccountError, QuotaExhaustedError } from "@multi-ai-router/core"
import type { AttemptFailure } from "../routing"
import type { ChainContext } from "./chain"
import type { ChainFailure } from "./chain-error"
import { attemptRecord, errorClassOf, outcomeOf } from "./records"

/**
 * `error.router.signal` on the refusal: the one machine token that tells a client this `429` is
 * the router's own recovery bookkeeping, not a provider's spent window.
 */
export const AWAITING_RECOVERY_PERMIT_SIGNAL = "awaiting-recovery-permit"

/** Each awaiting-permit refusal, and whether its one `UsageRecord` is still owed. */
const awaitingPermit = new WeakMap<QuotaExhaustedError, { readonly owesRecord: boolean }>()

/**
 * The chain sent nothing to the client and some candidate it reached was a recovering account whose
 * permit or half-open probe belonged to someone else. The dispatcher may wait and re-route
 * (`recovery-wait.ts`), so this refusal is **not** recorded here: when no attempt ran, its one
 * `UsageRecord` is the dispatcher's to write once it gives up ({@link owesRefusalRecord}).
 */
export function isAwaitingRecoveryPermit(error: unknown): error is QuotaExhaustedError {
  return error instanceof QuotaExhaustedError && awaitingPermit.has(error)
}

/** True when no attempt of the chain wrote a row, so the refusal itself must. */
export function owesRefusalRecord(error: QuotaExhaustedError): boolean {
  return awaitingPermit.get(error)?.owesRecord ?? false
}

/**
 * Whether a refusal outranks what the chain otherwise holds. Nothing held, or a clock-recoverable
 * `429` from another account: a recovering account about to take its permit is a better answer
 * than a spent window days out (prod, 2026-10-06 23:16:02). Anything else is the honest answer.
 */
function yieldsToRefusal(held: ChainFailure | null): boolean {
  if (held === null) return true
  return (held.kind === "router" ? held.error.status : held.upstream.status) === 429
}

/** Refusal is request accounting, never a provider attempt or an account strike. */
export function createChainRefusals(ctx: ChainContext) {
  /** The soonest any refused account's probe hold ends: the earliest it could take a request. */
  let refusedUntil: Date | null = null
  let preparationFailed = false
  return {
    record(accountId: string) {
      const until = ctx.runtime.health.probeHoldUntil(accountId, ctx.runtime.clock.now())
      if (refusedUntil === null || until.getTime() < refusedUntil.getTime()) refusedUntil = until
    },
    recordPreparation() {
      preparationFailed = true
    },
    failIfAny(held: ChainFailure | null, lastFailure: AttemptFailure | null): void {
      if (refusedUntil === null && !preparationFailed) return
      const now = ctx.runtime.clock.now()
      if (refusedUntil !== null && yieldsToRefusal(held)) {
        // The permit's arrival is not known here, so the honest wait is the probe hold — never the
        // coordinator's re-check tick, a park that lapsed before the permit (developerz.ai, 2026-11-20).
        const wait = refusedUntil.getTime() - now.getTime()
        const error = new QuotaExhaustedError(
          "recovering accounts are awaiting a recovery permit",
          {
            retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)),
            resetsAt: refusedUntil,
            detail: { signal: AWAITING_RECOVERY_PERMIT_SIGNAL, resetSource: "estimated" },
          },
        )
        awaitingPermit.set(error, { owesRecord: held === null && lastFailure === null })
        throw error
      }
      if (held !== null || lastFailure !== null) return
      const error = new NoHealthyAccountError("upstream dispatch could not be prepared")
      ctx.runtime.record(
        attemptRecord({
          ...ctx.runtime.preflightAttribution(),
          timing: ctx.runtime.timing(now, ctx.runtime.requestStarted, 0),
          outcome: outcomeOf(error),
          streamed: false,
          httpStatus: null,
          errorClass: errorClassOf(error),
        }),
      )
      throw error
    },
  }
}
