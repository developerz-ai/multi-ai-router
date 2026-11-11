import type { RoutableAccount, RoutingCatalog } from "../dataplane"
import type { PoolSnapshot } from "../routing"
import { createSnapshotRefresh } from "../snapshots/refresh"
import { createJitteredRefreshTimer } from "../snapshots/timer"
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
 * caller — on the timer, to `onRefreshError`, so a snapshot going stale is a log
 * line and not a silence. Serving slightly stale routing beats serving none: the
 * alternative is a total outage because a periodic query timed out.
 */

export interface RoutingCatalogStore extends RoutingCatalog {
  /** Re-reads the world. Rejects on failure, leaving the last good snapshot in place. */
  refresh(): Promise<void>
  /** Waits for an installed snapshot whose read began after this mutation committed. */
  refreshAfterMutation(): Promise<void>
  /** Begins periodic refresh. Idempotent. */
  start(): void
  stop(): void
  /** When the held snapshot was last replaced. `null` before the first successful load. */
  loadedAt(): Date | null
  /**
   * One account by id, from an index built once per installed snapshot — so a request that needs
   * one account (`plan.ts`, the orchestrator) never walks or re-indexes the whole catalog.
   */
  account(id: string): RoutableAccount | undefined
}

export interface RoutingCatalogStoreDeps {
  readonly load: () => Promise<CatalogData>
  /** Runs before the installed snapshot becomes observable or a mutation barrier resolves. */
  readonly onInstalled?: (accounts: readonly RoutableAccount[]) => void
  /** Staleness bound for a write made by another replica. Config, never a constant. */
  readonly refreshIntervalMs: number
  readonly now?: () => Date
  /** Injected so a test is deterministic; production leaves it alone. */
  readonly jitter?: (intervalMs: number) => number
  /**
   * A timer tick's refresh failed; the previous snapshot stays installed and the next tick retries.
   * Absent, the failure is dropped — which only a test should accept: the composition root wires it
   * to a warn line, so routing on an hours-old catalog is never silent.
   */
  readonly onRefreshError?: (error: unknown) => void
}

interface Installed {
  readonly data: CatalogData
  readonly byId: ReadonlyMap<string, RoutableAccount>
}

const EMPTY: Installed = { data: { accounts: [], pools: [] }, byId: new Map() }

export function createRoutingCatalog(deps: RoutingCatalogStoreDeps): RoutingCatalogStore {
  const now = deps.now ?? (() => new Date())
  let installed: Installed = EMPTY
  let loadedAt: Date | null = null
  const { refresh, refreshAfterMutation } = createSnapshotRefresh(deps.load, (next) => {
    deps.onInstalled?.(next.accounts)
    installed = { data: next, byId: new Map(next.accounts.map((account) => [account.id, account])) }
    loadedAt = now()
  })

  const timer = createJitteredRefreshTimer({
    intervalMs: deps.refreshIntervalMs,
    refresh,
    ...(deps.onRefreshError === undefined ? {} : { onError: deps.onRefreshError }),
    ...(deps.jitter === undefined ? {} : { jitter: deps.jitter }),
  })

  return {
    accounts: (): readonly RoutableAccount[] => installed.data.accounts,
    pools: (): readonly PoolSnapshot[] => installed.data.pools,
    account: (id) => installed.byId.get(id),
    refresh,
    refreshAfterMutation,
    start: timer.start,
    stop: timer.stop,
    loadedAt: () => loadedAt,
  }
}
