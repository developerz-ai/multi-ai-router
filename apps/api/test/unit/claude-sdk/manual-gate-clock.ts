import type { SdkGateTimer } from "../../../src/providers"

/**
 * A hand-driven clock and timer for the SDK gate's wait budget. Time moves only when a test calls
 * `advance`, and a timer fires only when its instant is reached, in order, so a wait of sixty
 * seconds costs no real time and needs no fake-timer patching of the runtime (router CLAUDE.md
 * non-negotiable 9).
 */
export function manualGateClock() {
  let current = 0
  let nextHandle = 0
  const pending = new Map<number, { readonly at: number; readonly fire: () => void }>()

  const timer: SdkGateTimer = {
    set: (fire, ms) => {
      nextHandle += 1
      pending.set(nextHandle, { at: current + ms, fire })
      return nextHandle
    },
    clear: (handle) => {
      pending.delete(handle as number)
    },
  }

  return {
    now: () => current,
    timer,
    /** Moves time forward, firing every timer that comes due on the way, earliest first. */
    advance(ms: number): void {
      const target = current + ms
      for (;;) {
        let due: [number, { readonly at: number; readonly fire: () => void }] | undefined
        for (const entry of pending) {
          if (entry[1].at <= target && (due === undefined || entry[1].at < due[1].at)) due = entry
        }
        if (due === undefined) break
        pending.delete(due[0])
        current = Math.max(current, due[1].at)
        due[1].fire()
      }
      current = target
    },
    /** Timers still armed: a granted or aborted waiter must leave none behind. */
    get armed(): number {
      return pending.size
    },
  }
}

/** Enough microtask turns for a caller to reach a gate's queue; nothing here does real I/O. */
export async function turns(count = 6): Promise<void> {
  for (let i = 0; i < count; i += 1) await Promise.resolve()
}
