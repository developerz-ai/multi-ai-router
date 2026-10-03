import { type RefreshExpectation, type RefreshTimerState, sameExpectation } from "./identity"
import { timerDelayMs } from "./schedule"

/** Timer object ownership protects replaced credentials from canceled callbacks. */
export function createRefreshTimers(deps: {
  readonly schedule: (run: () => void, delayMs: number) => () => void
  readonly now: () => Date
  readonly stopped: () => boolean
  readonly timing: (id: string) => RefreshTimerState | undefined
  readonly due: (id: string, timing: RefreshTimerState) => void
}) {
  const timers = new Map<string, { cancel: () => void }>()
  const disarm = (id: string): void => {
    timers.get(id)?.cancel()
    timers.delete(id)
  }
  const armAt = (id: string, timing: RefreshTimerState): void => {
    disarm(id)
    if (deps.stopped()) return
    const armed = { cancel: () => {} }
    armed.cancel = deps.schedule(
      () => {
        if (timers.get(id) !== armed || deps.timing(id) !== timing) return
        timers.delete(id)
        if (deps.now().getTime() < timing.dueAtMs) {
          armAt(id, timing)
          return
        }
        deps.due(id, timing)
      },
      timerDelayMs(timing.dueAtMs, deps.now().getTime()),
    )
    timers.set(id, armed)
  }
  return {
    armAt,
    disarm,
    has: (id: string) => timers.has(id),
    defer: (id: string, expected: RefreshExpectation, delayMs: number): void => {
      const held = deps.timing(id)
      if (held === undefined || !sameExpectation(held, expected)) return
      held.dueAtMs = deps.now().getTime() + delayMs
      armAt(id, held)
    },
    clear: (): void => {
      for (const id of timers.keys()) disarm(id)
    },
  }
}
