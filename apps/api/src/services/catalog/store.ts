import type { RoutableAccount, RoutingCatalog } from "../dataplane"
import type { PoolSnapshot } from "../routing"
import type { CatalogData } from "./load"

/**
 * The warm routing catalog: the accounts and pools the data plane reads on every
 * request, held in memory and refreshed off the request path.
 *
 * `accounts()` and `pools()` are **synchronous by design**. They are the reason
 * this exists — a request that could await a query here would put Postgres on
 * the critical path, which CLAUDE.md non-negotiable 8 forbids. Everything that
 * can be slow is a `refresh`.
 *
 * Refresh happens in three ways, and the three cover different failure modes:
 *
 * - **At boot**, awaited, so the first request reads real data.
 * - **After an admin write**, awaited by the admin service, so the console is
 *   read-after-write consistent — an operator who adds an account and fires a
 *   request immediately gets the account they just added.
 * - **On a jittered timer**, so a write made by *another replica* lands here
 *   without a broker. This is the only mechanism that copes with more than one
 *   process, and it is why the interval is a bound on staleness, not a cache
 *   nicety.
 *
 * A failed refresh keeps the previous snapshot and reports the error to the
 * caller. Serving slightly stale routing beats serving none: the alternative is
 * a total outage because a periodic query timed out.
 */

export interface RoutingCatalogStore extends RoutingCatalog {
  /** Re-reads the world. Rejects on failure, leaving the last good snapshot in place. */
  refresh(): Promise<void>
  /** Begins periodic refresh. Idempotent. */
  start(): void
  stop(): void
  /** When the held snapshot was last replaced. `null` before the first successful load. */
  loadedAt(): Date | null
}

export interface RoutingCatalogStoreDeps {
  readonly load: () => Promise<CatalogData>
  /** Staleness bound for a write made by another replica. Config, never a constant. */
  readonly refreshIntervalMs: number
  readonly now?: () => Date
  /** Injected so a test is deterministic; production leaves it alone. */
  readonly jitter?: (intervalMs: number) => number
}

const EMPTY: CatalogData = { accounts: [], pools: [] }

export function createRoutingCatalog(deps: RoutingCatalogStoreDeps): RoutingCatalogStore {
  const now = deps.now ?? (() => new Date())
  const jitter = deps.jitter ?? defaultJitter
  let data: CatalogData = EMPTY
  let loadedAt: Date | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  // Concurrent refreshes would be two identical queries racing to install the
  // same snapshot; callers share the one in flight instead.
  let inFlight: Promise<void> | null = null

  const refresh = (): Promise<void> => {
    inFlight ??= deps
      .load()
      .then((next) => {
        data = next
        loadedAt = now()
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  const schedule = (): void => {
    timer = setTimeout(() => {
      // Swallowed on purpose: a periodic refresh that throws must not take the
      // process down, and the next tick retries. The snapshot stays as it was.
      void refresh().catch(() => undefined)
      if (timer !== null) schedule()
    }, jitter(deps.refreshIntervalMs))
    timer.unref?.()
  }

  return {
    accounts: (): readonly RoutableAccount[] => data.accounts,
    pools: (): readonly PoolSnapshot[] => data.pools,
    refresh,
    start: () => {
      if (timer === null) schedule()
    },
    stop: () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    loadedAt: () => loadedAt,
  }
}

/**
 * ±20%. Replicas start together — under a fixed interval they would refresh in
 * lockstep for the life of the deployment, turning a cheap query into a
 * synchronised burst.
 */
function defaultJitter(intervalMs: number): number {
  return Math.round(intervalMs * (0.8 + Math.random() * 0.4))
}
