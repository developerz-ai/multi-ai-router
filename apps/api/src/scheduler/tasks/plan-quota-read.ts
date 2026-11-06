import type { AccountRepository } from "@multi-ai-router/db"
import type { RoutableAccount } from "../../services/dataplane"
import {
  isPlanQuotaReadable,
  type PlanQuotaOutcome,
  selectForPlanQuotaRead,
} from "../../services/models"
import type { ScheduledTask } from "../types"

/**
 * Keeps the gauges of plan accounts whose upstream reports usage only on its own endpoint current.
 * Traffic carries no such reading for them, so without this they would show nothing at all. Free:
 * a usage read spends no tokens and no quota window.
 *
 * **Bounded, idempotent, resumable.** One batch per tick, longest-unread first, abort checked
 * between accounts; a second run re-reads the same windows and the fresher clock wins. Every reading
 * is advisory, and a failed read writes nothing: this task can never take an account out of rotation.
 */

export interface PlanQuotaReadPorts {
  /** The warm catalog. Facts for the observation guard come from here, not from a fresh row. */
  readonly accounts: () => readonly RoutableAccount[]
  /** One Account's read, handed in so the task owns the loop and the service owns the work. */
  readonly read: (account: RoutableAccount) => Promise<PlanQuotaOutcome>
}

export interface PlanQuotaReadDeps extends PlanQuotaReadPorts {
  /** The durable stamp of each Account's last reading, on whichever replica took it. */
  readonly windows: Pick<AccountRepository, "listQuotaWindows">
  /** `PLAN_QUOTA_READ_INTERVAL_MINUTES`, in milliseconds. The runner jitters it. */
  readonly intervalMs: number
  /** `PLAN_QUOTA_READ_BATCH_SIZE`. Each item is one outbound GET. */
  readonly batchSize: number
}

/** Nothing wired means no task, like every other sweep with nothing to ask. */
export function createPlanQuotaReadTasks(
  ports: PlanQuotaReadPorts | undefined,
  options: Pick<PlanQuotaReadDeps, "windows" | "intervalMs" | "batchSize">,
): readonly ScheduledTask[] {
  return ports === undefined ? [] : [createPlanQuotaReadTask({ ...ports, ...options })]
}

export function createPlanQuotaReadTask(deps: PlanQuotaReadDeps): ScheduledTask {
  // Per account, so bounded by the account count. Pruned below as accounts leave.
  const lastLookAt = new Map<string, Date>()

  return {
    name: "plan_quota_read",
    intervalMs: deps.intervalMs,

    run: async ({ now, logger, signal }) => {
      const accounts = deps.accounts().filter(isPlanQuotaReadable)
      const known = new Set(accounts.map((account) => account.id))
      for (const id of lastLookAt.keys()) if (!known.has(id)) lastLookAt.delete(id)

      const rows = await deps.windows.listQuotaWindows([...known])
      const lastReadAt = new Map<string, Date>()
      for (const row of rows) {
        const held = lastReadAt.get(row.accountId)
        if (held === undefined || row.lastCheckedAt > held)
          lastReadAt.set(row.accountId, row.lastCheckedAt)
      }

      // Half an interval, not a whole one: the runner jitters, and a tick landing early must not
      // find every account "still fresh" and skip a whole round.
      const due = selectForPlanQuotaRead(accounts, lastReadAt, lastLookAt, now, deps.intervalMs / 2)
      const tally = { read: 0, skipped: 0, failed: 0 }

      for (const account of due.slice(0, deps.batchSize)) {
        if (signal.aborted) {
          logger.info("plan quota read", { outcome: "partial", due: due.length, ...tally })
          return { outcome: "partial", itemsProcessed: tally.read }
        }
        lastLookAt.set(account.id, now)
        const outcome = await deps.read(account)
        tally[outcome.kind] += 1
        if (outcome.kind === "read") continue

        const fields = {
          accountId: account.id,
          provider: account.snapshot.provider,
          reason: outcome.reason,
        }
        // Info for a skip: a key with no plan says so every tick, and that is its shape.
        if (outcome.kind === "skipped") logger.info("plan quota read skipped an account", fields)
        else logger.warn("plan quota read failed for an account", fields)
      }

      const outcome = tally.failed > 0 || due.length > deps.batchSize ? "partial" : "success"
      logger.info("plan quota read", { outcome, due: due.length, ...tally })
      return { outcome, itemsProcessed: tally.read }
    },
  }
}
