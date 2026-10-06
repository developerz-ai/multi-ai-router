import { NoHealthyAccountError, QuotaExhaustedError } from "@multi-ai-router/core"
import type { AttemptFailure } from "../routing"
import type { ChainContext } from "./chain"
import type { ChainFailure } from "./chain-error"
import { DEFAULT_PROBE_HOLD_MS } from "./health"
import { attemptRecord, errorClassOf, outcomeOf } from "./records"

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
  let refused = false
  let preparationFailed = false
  return {
    record() {
      refused = true
    },
    recordPreparation() {
      preparationFailed = true
    },
    failIfAny(held: ChainFailure | null, lastFailure: AttemptFailure | null): void {
      if (!refused && !preparationFailed) return
      const now = ctx.runtime.clock.now()
      if (refused && yieldsToRefusal(held)) {
        const wait = ctx.runtime.recovery?.retryAfterMs ?? DEFAULT_PROBE_HOLD_MS
        const error = new QuotaExhaustedError(
          "recovering accounts are awaiting a recovery permit",
          {
            retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)),
            resetsAt: new Date(now.getTime() + wait),
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
