import type { SelectionDecision } from "../routing"

/**
 * Whether a model throttle hold — the router's own pace for one (account, model), seconds long —
 * lapses before `deadline` on some rejected account (prod 2026-11-28: a free key's holds answered
 * `429` while a request a second later was served). Its neighbours, as in
 * `awaitsRouterRecovery` (`recovery-wait.ts`), cannot serve inside the wait either way. Bindings are
 * not read.
 */
export function awaitsModelHold(decision: SelectionDecision, deadline: Date): boolean {
  if (decision.binding.state === "blocked") return false
  return decision.rejected.some(
    (entry) =>
      entry.modelHold === true &&
      entry.resetsAt !== undefined &&
      entry.resetsAt.getTime() <= deadline.getTime(),
  )
}
