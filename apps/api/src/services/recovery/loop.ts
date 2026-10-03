/** Object ownership fences canceled callbacks across coordinator restart. */
export function createRecoveryLoop(deps: {
  schedule: (work: () => void, delayMs: number) => () => void
  intervalMs: number
  tick: () => Promise<void>
  stopped: () => boolean
}) {
  let armed: { cancel: () => void } | undefined
  const start = (): void => {
    if (deps.stopped() || armed !== undefined) return
    const owner = { cancel: () => {} }
    armed = owner
    owner.cancel = deps.schedule(() => {
      if (armed !== owner || deps.stopped()) return
      armed = undefined
      void deps.tick().finally(start)
    }, deps.intervalMs)
  }
  return {
    start,
    stop: (): void => {
      const owner = armed
      armed = undefined
      owner?.cancel()
    },
  }
}
