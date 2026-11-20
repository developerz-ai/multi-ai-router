import { describeError } from "@multi-ai-router/core"
import type { AccountRepository, PoolRepository } from "@multi-ai-router/db"
import type { PoolRoster } from "../../config/pool-roster"
import type { RosterDriftSeries } from "../../observability/metric-types"
import type { ScheduledTask, TaskOutcome } from "../types"
import {
  diffRoster,
  type LiveRoster,
  type LiveRosterPool,
  type RosterDriftItem,
} from "./pool-roster-diff"

/**
 * The roster check: reads the pools and members that are actually live, folds them against the
 * declarative roster (`POOL_ROSTER_PATH`), and reports every place the two disagree.
 *
 * **It reports; it never reconciles.** Nothing here writes a pool, a membership or an account. A
 * drift is a decision — an account was retired, a label was typo'd, an operator meant to add the
 * member — so the check's whole output is an alert line and a gauge. A task that "fixed" the
 * roster by editing the database would be a background process silently changing what the operator
 * declared, and the roster would stop being the source of truth it exists to be.
 *
 * **A drift is an alert, per item** — one `logger.warn` line each, which is what an alert rule
 * matches (docs/idea/08-observability.md). A pool that vanished may read as an empty pool to the
 * routing policy; a pool whose overflow is gone serves nothing once its members filter out. Both
 * are visible to a client as failures, so neither belongs in an info line.
 *
 * **No credential ever reaches these lines.** Only labels, pool names and ids — the roster and the
 * summary projection never carry auth material (`listSummaries` is the ciphertext-free read).
 *
 * Idempotent and unbounded-batch-free by construction: the whole run is two reads and a fold, so
 * there is no batch to bound, nothing to resume, and running it twice reports the same drift twice.
 */

export interface PoolRosterCheckDeps {
  /** The configured roster. Non-null: a deployment without one builds no task at all. */
  readonly roster: PoolRoster
  /**
   * `list` and `listMembersForPools` are the whole live side. Read-only on purpose — this task has
   * no write capability to reach for.
   */
  readonly pools: Pick<PoolRepository, "list" | "listMembersForPools">
  /** The label-to-id join. `listSummaries` omits the credential columns, so none is loaded. */
  readonly accounts: Pick<AccountRepository, "listSummaries">
  /** Rebuilds `router_pool_roster_drift` — replaced wholesale, so a repaired item disappears. */
  readonly recordDrift: (items: readonly RosterDriftSeries[]) => void
  /** `POOL_ROSTER_CHECK_INTERVAL_MINUTES`, in milliseconds. The runner jitters it. */
  readonly intervalMs: number
}

/** What the composition root hands in; `intervalMs` is config. */
export type PoolRosterCheckPorts = Omit<PoolRosterCheckDeps, "intervalMs">

/**
 * No ports or no cadence, no task: no roster configured means nothing to compare, and a `null`
 * cadence would otherwise become a `0` ms timer — a task spinning on the database.
 */
export function createPoolRosterCheckTasks(
  ports: PoolRosterCheckPorts | undefined,
  options: { readonly intervalMs: number | null },
): readonly ScheduledTask[] {
  if (ports === undefined || options.intervalMs === null) return []
  return [createPoolRosterCheckTask({ ...ports, intervalMs: options.intervalMs })]
}

export function createPoolRosterCheckTask(deps: PoolRosterCheckDeps): ScheduledTask {
  return {
    name: "pool_roster_check",
    intervalMs: deps.intervalMs,

    run: async ({ logger, signal }): Promise<TaskOutcome> => {
      try {
        const live = await readLive(deps)
        if (signal.aborted) return { outcome: "success", itemsProcessed: 0 }

        const items = diffRoster(deps.roster, live)
        for (const item of items) {
          // The `pool` field is the roster's name on `pool_missing` (no id exists) and the live
          // name otherwise; `account` is the label, or the id when no account answers it.
          logger.warn("pool roster drift", {
            pool: item.poolName,
            poolId: item.poolId,
            kind: item.kind,
            account: item.accountLabel ?? item.accountId,
          })
        }
        deps.recordDrift(series(items))
        return { outcome: "success", itemsProcessed: items.length }
      } catch (error) {
        // A read that failed leaves the gauge as the previous run set it — stale, and honestly so:
        // clearing it here would report "no drift" for a check that did not run.
        return {
          outcome: "failed",
          itemsProcessed: 0,
          error: describeError(error, Number.POSITIVE_INFINITY),
        }
      }
    },
  }
}

async function readLive(
  deps: Pick<PoolRosterCheckDeps, "pools" | "accounts">,
): Promise<LiveRoster> {
  const [pools, accounts] = await Promise.all([deps.pools.list(), deps.accounts.listSummaries()])
  const memberships =
    pools.length === 0 ? [] : await deps.pools.listMembersForPools(pools.map((pool) => pool.id))
  const membersByPool = new Map<string, string[]>()
  for (const membership of memberships) {
    const held = membersByPool.get(membership.poolId)
    if (held === undefined) membersByPool.set(membership.poolId, [membership.accountId])
    else held.push(membership.accountId)
  }
  const livePools: LiveRosterPool[] = pools.map((pool) => ({
    id: pool.id,
    name: pool.name,
    memberIds: membersByPool.get(pool.id) ?? [],
    overflowAccountId: pool.overflowAccountId,
  }))
  return { pools: livePools, accounts: accounts.map((a) => ({ id: a.id, label: a.label })) }
}

/**
 * One series per (pool, kind), counted. The gauge is a count of items, so two missing members in
 * one pool are one series reading `2`, not two series — the label set stays bounded by the roster
 * and the alert rule reads one line per kind.
 */
function series(items: readonly RosterDriftItem[]): readonly RosterDriftSeries[] {
  const counts = new Map<string, RosterDriftSeries>()
  for (const item of items) {
    const poolId = item.poolId ?? item.poolName
    const key = `${poolId}\u0000${item.kind}`
    const held = counts.get(key)
    if (held === undefined) counts.set(key, { poolId, kind: item.kind, count: 1 })
    else counts.set(key, { poolId, kind: item.kind, count: held.count + 1 })
  }
  return [...counts.values()]
}
