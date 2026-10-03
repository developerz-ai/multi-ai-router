/** Credential commits survive catalog failure; retry only coherence, never the spent grant. */
export function createRefreshCoherence(deps: {
  readonly refresh: () => Promise<void>
  readonly schedule: (run: () => void, delayMs: number) => () => void
  readonly minDelayMs: number
  readonly onError: (error: unknown) => void
}) {
  let revision = 0
  let dirty = false
  let stopped = false
  let armed: { cancel: () => void } | undefined
  const pending = new Set<Promise<void>>()
  const arm = (): void => {
    if (stopped || !dirty || armed !== undefined) return
    const owner = { cancel: () => {} }
    owner.cancel = deps.schedule(() => {
      if (armed !== owner) return
      armed = undefined
      if (!stopped && dirty) void flush(revision)
    }, deps.minDelayMs)
    armed = owner
  }
  const flush = (expected: number): Promise<void> => {
    const work = (async () => {
      try {
        await deps.refresh()
        if (revision === expected) dirty = false
      } catch (error) {
        deps.onError(error)
      } finally {
        arm()
      }
    })().finally(() => pending.delete(work))
    pending.add(work)
    return work
  }
  return {
    changed: (): Promise<void> => {
      dirty = true
      const current = ++revision
      armed?.cancel()
      armed = undefined
      return flush(current)
    },
    start: (): void => {
      stopped = false
      arm()
    },
    stopTimers: (): void => {
      stopped = true
      armed?.cancel()
      armed = undefined
    },
    drain: async (): Promise<void> => {
      await Promise.allSettled([...pending])
    },
  }
}
