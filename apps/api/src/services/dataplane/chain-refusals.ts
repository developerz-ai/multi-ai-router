import { NoHealthyAccountError, QuotaExhaustedError } from "@multi-ai-router/core"
import type { ChainContext } from "./chain"
import { DEFAULT_PROBE_HOLD_MS } from "./health"
import { attemptRecord, errorClassOf, outcomeOf } from "./records"

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
    failIfAny(): void {
      if (!refused && !preparationFailed) return
      const now = ctx.runtime.clock.now()
      const wait = ctx.runtime.recovery?.retryAfterMs ?? DEFAULT_PROBE_HOLD_MS
      const error = !refused
        ? new NoHealthyAccountError("upstream dispatch could not be prepared")
        : new QuotaExhaustedError("recovering accounts are awaiting a recovery permit", {
            retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)),
            resetsAt: new Date(now.getTime() + wait),
          })
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
