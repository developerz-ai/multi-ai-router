/**
 * The pool's *opened* connections, for `router_db_pool_connections{state="idle"}` (12.18).
 *
 * The gauge used to report capacity minus in-use, which read 12 idle while Postgres held 4
 * backends. The true count is a `pg_stat_activity` query (`DatabaseHandle.openConnections`), and a
 * scrape is synchronous and must never wait on the pool it describes. So each scrape starts at
 * most one read — discarded if it lands past `timeoutMs` — and reports the last one that landed: a slow or saturated pool skips a
 * sample (the reading goes stale by one scrape), it never blocks `/metrics`.
 */
export interface OpenConnectionsReading {
  /** The last landed count, or `undefined` before the first; starts the next read. */
  sample(): number | undefined
}

export function createOpenConnectionsReading(deps: {
  readonly read: () => Promise<number>
  readonly timeoutMs: number
}): OpenConnectionsReading {
  let last: number | undefined
  let inFlight = false
  const refresh = (): void => {
    // One read outstanding at most, held until it settles: on a saturated pool the read itself
    // queues, and stacking one per scrape is the load this must not add.
    if (inFlight) return
    inFlight = true
    const startedAt = Date.now()
    void deps
      .read()
      .then(
        (count) => {
          // Past its deadline a count describes a pool that has since moved on; skip it.
          if (Date.now() - startedAt <= deps.timeoutMs) last = count
        },
        // A failed read is a skipped sample; the database's own health is `/readyz`'s to report.
        () => undefined,
      )
      .finally(() => {
        inFlight = false
      })
  }
  return {
    sample() {
      refresh()
      return last
    },
  }
}
