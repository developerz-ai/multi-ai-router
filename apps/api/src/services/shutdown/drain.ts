/**
 * The bounded half of a graceful shutdown.
 *
 * `Bun.serve().stop()` already does the kind thing, and does not bound it: unforced, it stops
 * listening and then resolves only once the **last in-flight request has ended** — and a streamed
 * completion is a request that legitimately runs for minutes. Awaited bare, the exit belongs to
 * whatever kills first: `docker stop`'s ten-second grace, or a Kubernetes
 * `terminationGracePeriodSeconds`. That `SIGKILL` truncates the very streams the wait was
 * protecting *and* takes the queued usage rows, quota readings and status verdicts with it, because
 * the flush that would have written them is still parked behind the listener.
 *
 * So the wait gets a deadline. Inside it, every in-flight response finishes and the flush that
 * follows records what they earned. Past it, the wait ends anyway and the caller goes on to flush
 * and exit: the responses still open are truncated by that exit, which is one truncation the router
 * chose, counted and logged, instead of the orchestrator truncating everything at once and taking
 * the bookkeeping with it.
 *
 * Pure over an injected server and clock: no `Bun` import and no timer outliving the call, so a
 * test drives it with a fake server and no listener at all.
 */

/** The slice of `Bun.Server` a drain touches. Structural, so nothing here has to open a port. */
export interface DrainableServer {
  /**
   * Requests the server is still serving. A streamed response counts until its last byte, which is
   * exactly the population being drained — not just the handlers that have yet to return.
   */
  readonly pendingRequests: number
  /**
   * Stops listening. Unforced, the promise resolves when the last in-flight request has ended.
   *
   * The `true` overload is deliberately not used past that first call, and it is not an oversight:
   * once an unforced stop is in flight, bun ignores the flag on a later one and the second call
   * simply waits for natural completion alongside the first (measured against bun 1.3, and
   * `test/integration/shutdown.test.ts` re-measures it). So what closes the responses this function
   * gives up on is the caller's exit, which is the caller's to decide anyway.
   */
  stop(closeActiveConnections?: boolean): Promise<void>
}

export interface DrainOutcome {
  /** How many requests were in flight when the drain began. */
  readonly pending: number
  /** How many were still in flight at the deadline, and so will not survive the exit. */
  readonly abandoned: number
  readonly waitedMs: number
  readonly timedOut: boolean
}

export interface DrainInput {
  readonly server: DrainableServer
  /** How long in-flight requests get. `0` closes them at once, which is a legitimate setting. */
  readonly timeoutMs: number
  /** Monotonic reading, injected so a test measures no wall clock. */
  readonly now?: () => number
}

export async function drainServer(input: DrainInput): Promise<DrainOutcome> {
  const { server, timeoutMs, now = () => performance.now() } = input
  const started = now()
  const pending = server.pendingRequests

  // Called before anything is awaited, so the socket stops accepting *while* the deadline runs
  // rather than after it. The promise it returns is the drain itself; the race below is the bound.
  //
  // A rejected stop is still a stop: nothing is left to wait for, and letting the rejection escape
  // would abandon the flush this function exists to protect.
  const drained = server.stop().then(
    () => true,
    () => true,
  )

  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })

  try {
    if (await Promise.race([drained, expired])) {
      return { pending, abandoned: 0, waitedMs: now() - started, timedOut: false }
    }
  } finally {
    // Otherwise the handle holds the loop open for the remainder of a deadline that already lost.
    clearTimeout(timer)
  }

  // Returning is the whole escalation. Nothing here forces the survivors closed — see the note on
  // `stop` — and nothing here should: the caller now flushes what it is holding and exits, and the
  // exit is what ends them. Reported rather than silent, so the truncation is one line in the log
  // with a number on it instead of a client-side mystery.
  return { pending, abandoned: server.pendingRequests, waitedMs: now() - started, timedOut: true }
}
