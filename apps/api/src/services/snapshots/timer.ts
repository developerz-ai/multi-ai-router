/**
 * The periodic half of a warm store's refresh, shared by the routing catalog, the model catalog and
 * the price book (plan 101, 04.5: three identical copies). One timer per store, re-armed after each
 * tick, `unref`'d so it never holds the process open.
 *
 * A tick's refresh is never rethrown: a periodic read that throws must not take the process down,
 * and the next tick retries. The store keeps its last good snapshot; the failure goes to `onError`.
 */
export interface JitteredRefreshTimerDeps {
  /** Staleness bound for a write made by another replica. Config, never a constant. */
  readonly intervalMs: number
  readonly refresh: () => Promise<void>
  readonly onError?: (error: unknown) => void
  /** Injected so a test is deterministic; production leaves it alone. */
  readonly jitter?: (intervalMs: number) => number
}

export interface JitteredRefreshTimer {
  /** Idempotent: a running timer is left alone. */
  start(): void
  stop(): void
}

export function createJitteredRefreshTimer(deps: JitteredRefreshTimerDeps): JitteredRefreshTimer {
  const jitter = deps.jitter ?? defaultJitter
  let timer: ReturnType<typeof setTimeout> | null = null

  const schedule = (): void => {
    timer = setTimeout(() => {
      void deps.refresh().catch((error: unknown) => deps.onError?.(error))
      if (timer !== null) schedule()
    }, jitter(deps.intervalMs))
    timer.unref?.()
  }

  return {
    start: () => {
      if (timer === null) schedule()
    },
    stop: () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}

/**
 * ±20%. Replicas start together — under a fixed interval they would refresh in lockstep for the
 * life of the deployment, turning a cheap query into a synchronised burst.
 */
export function defaultJitter(intervalMs: number): number {
  return Math.round(intervalMs * (0.8 + Math.random() * 0.4))
}
