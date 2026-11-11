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
    const selection = selectAccounts(
      buildSnapshot(deps.catalog, deps.health, clock.now(), rotation),
      { ...deps.request, rotationCounter: rotation.current(null) },
      deps.selection,
    )
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
