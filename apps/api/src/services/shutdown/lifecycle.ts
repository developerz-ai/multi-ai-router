/**
 * The one bit of state a shutdown has that the rest of the process needs to see.
 *
 * Two callers, one fact, and it has to be the *same* fact or both are wrong:
 *
 * - **`/readyz`.** A router that is draining is not ready, and it stops being ready *before* the
 *   listener stops accepting rather than after. An orchestrator that polls readiness gets one
 *   honest `503` and pulls the endpoint; without it the first thing the load balancer learns is a
 *   refused connection, which it reports as an error to whoever was mid-request. The window is
 *   small and it is the whole window an already-established keep-alive connection has.
 * - **The signal handlers.** The drain is deliberately long (`SHUTDOWN_DRAIN_MS`), which makes a
 *   second signal likely — an orchestrator escalating, an operator pressing Ctrl-C again. Re-entering
 *   would run the flush twice and close the pool underneath the first pass, so the second signal has
 *   to be recognisable as a second one.
 *
 * Keeping those as two booleans is how they drift: readiness would go on answering `ready` through
 * a drain nobody told it about. So it is one latch, set once, read by both.
 *
 * No `Bun`, no timers, no I/O — a test drives it directly.
 */

export interface Lifecycle {
  /** True from the moment a shutdown was accepted, before any of it has run. */
  readonly shuttingDown: () => boolean
  /**
   * Latches the shutdown.
   *
   * `true` for the caller that won and now owns the shutdown; `false` for every later one, which
   * means it is a repeat signal and must not start a second pass.
   */
  begin(): boolean
}

export function createLifecycle(): Lifecycle {
  let shuttingDown = false
  return {
    shuttingDown: () => shuttingDown,
    begin: () => {
      if (shuttingDown) return false
      shuttingDown = true
      return true
    },
  }
}
