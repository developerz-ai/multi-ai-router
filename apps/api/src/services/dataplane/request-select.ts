import { NoHealthyAccountError } from "@multi-ai-router/core"
import {
  type SelectionOptions,
  type SelectionRequest,
  type SelectionResult,
  selectAccounts,
} from "../routing"
import type { HealthStore } from "./health"
import type { RecoveryAccess } from "./recovery-access"
import { hintRecoveryRejections } from "./recovery-hints"
import type { RotationCounters } from "./rotation"
import { buildSnapshot } from "./snapshot"
import type { DataPlaneClock, RoutingCatalog } from "./types"

/**
 * One request's selection, re-runnable while it waits out a recovery hold. The request places
 * once: re-selections and chain retries do not stride the rotation (plan 101, 03.2).
 */
export function requestSelector(deps: {
  readonly accountEligible?: ((accountId: string) => boolean) | undefined
  readonly catalog: RoutingCatalog
  readonly health: HealthStore
  readonly recovery: RecoveryAccess | undefined
  readonly clock: DataPlaneClock
  readonly rotation: RotationCounters
  readonly selection: SelectionOptions | undefined
  readonly request: Omit<SelectionRequest, "rotationCounter">
}): () => SelectionResult {
  let placed = false
  return () => {
    const { clock, rotation } = deps
    const snapshot = buildSnapshot(deps.catalog, deps.health, clock.now(), rotation)
    const foreign = new Set(
      snapshot.accounts
        .filter((account) => account.carriesSession && deps.accountEligible?.(account.id) === false)
        .map((account) => account.id),
    )
    const request = { ...deps.request, rotationCounter: rotation.current(null) }
    const original = selectAccounts(snapshot, request, deps.selection)
    const bound = deps.request.binding?.accountId
    if (bound !== undefined && foreign.has(bound))
      return {
        ok: false,
        decision: original.decision,
        error: new NoHealthyAccountError(
          "session is bound to an account owned by another replica",
          {
            detail: { signal: "session-owner-unavailable" },
          },
        ),
      }
    let selection =
      foreign.size === 0
        ? original
        : selectAccounts(
            {
              ...snapshot,
              accounts: snapshot.accounts.filter((account) => !foreign.has(account.id)),
            },
            { ...deps.request, rotationCounter: rotation.current(null) },
            deps.selection,
          )
    // Keep catalog scope/model facts when omission leaves no local candidate.
    if (!selection.ok && foreign.size > 0)
      selection = original.ok
        ? {
            ok: false,
            decision: original.decision,
            error: new NoHealthyAccountError("account replica ownership temporarily unavailable", {
              detail: { signal: "account-owner-unavailable" },
            }),
          }
        : original
    // Advanced in the read's synchronous step, or concurrent requests share one counter — and only
    // for the group whose policy placed the head: another pool's rotation is not this one's.
    const head = selection.ok ? selection.candidates[0] : undefined
    if (!placed && head !== undefined && selection.decision.binding.state !== "honored") {
      rotation.advance(head.poolId)
      placed = true
    }
    hintRecoveryRejections(
      selection.decision.rejected,
      deps.recovery,
      deps.request.model,
      clock.now(),
    )
    return selection
  }
}
