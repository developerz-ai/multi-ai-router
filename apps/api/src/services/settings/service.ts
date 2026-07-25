import type {
  AuditRepository,
  PriceOverrideRepository,
  PriceOverrideRow,
  ScheduledTaskName,
  ScheduledTaskRepository,
} from "@multi-ai-router/db"
import { scheduledTask } from "@multi-ai-router/db"
import type { Env } from "../../config/env"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin"
import { type AdminResult, ok } from "../admin/result"
import { listShippedRates } from "../cost"
import { diffPriceOverrides, PRICE_OVERRIDES_SETTING, priceOverrideAuditDetail } from "./audit"
import {
  AUDIT_LIMIT_MAX,
  type AuditQuery,
  type AuditView,
  type SettingsView,
  type TaskHealthView,
  toAuditEventView,
  toPriceOverrideView,
  toPriceRateView,
  type UpdatePriceOverridesInput,
} from "./schema"
import { toTaskStatusView } from "./tasks"

/**
 * The settings screen, server side.
 *
 * **One service for three reads, not three services.** Configuration, background-task health and
 * the activity feed are one screen and one operator question — *"is this deployment set up and
 * running the way I think it is?"* — and splitting them would put three near-identical dependency
 * bundles in the composition root to answer it. They are separate *routes* because they refresh at
 * different rates: the config is static, task health ticks, and the feed is paged.
 *
 * Only one of the four operations writes, and only to the price table. Everything else on this
 * screen is environment configuration, read at boot and never mutable from the console
 * (CLAUDE.md non-negotiable 11).
 */

export interface SettingsService {
  read(): Promise<AdminResult<SettingsView>>
  update(input: UpdatePriceOverridesInput): Promise<AdminResult<SettingsView>>
  tasks(): Promise<AdminResult<TaskHealthView>>
  audit(query: AuditQuery): Promise<AdminResult<AuditView>>
}

export interface SettingsServiceDeps {
  readonly prices: Pick<PriceOverrideRepository, "list" | "replaceAll">
  readonly scheduledTasks: Pick<ScheduledTaskRepository, "lastRun" | "lastSuccess">
  /** Read-only. The audit log is append-only, and this service reads it through two methods. */
  readonly auditEvents: Pick<AuditRepository, "list" | "listForSubject">
  readonly audit: AuditRecorder
  /** A full `Env` satisfies this, so the composition root passes `env` straight through. */
  readonly env: Pick<Env, "retention" | "logLevel" | "janitorIntervalMinutes">
  /**
   * Each task's cadence in milliseconds — `scheduledTaskIntervals(env)`, the same function
   * `createScheduledTasks` builds the running tasks from. Injected rather than re-derived from
   * `Env` here, so the screen cannot judge health against a schedule nobody is running.
   */
  readonly intervals: Readonly<Record<ScheduledTaskName, number>>
  readonly now: () => Date
  /**
   * Bound to the warm price book's `refresh()`. Awaited before `update` resolves, so a saved
   * override is already pricing requests by the time the console sees the response — the same
   * read-after-write guarantee `services/admin/coherence.ts` gives the routing catalog, and
   * affordable for the same reason: no latency budget applies to the admin plane.
   */
  readonly onPricesChanged?: () => Promise<void>
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
  const view = (overrides: readonly PriceOverrideRow[]): SettingsView => ({
    retention: deps.env.retention,
    logLevel: deps.env.logLevel,
    janitorIntervalMinutes: deps.env.janitorIntervalMinutes,
    prices: {
      shipped: listShippedRates().map(toPriceRateView),
      overrides: overrides.map(toPriceOverrideView),
    },
  })

  return {
    read: async () => ok(view(await deps.prices.list())),

    update: async (input) => {
      // Read before write, so the audit event can say how much moved. One extra query on a screen
      // an operator saves by hand; the alternative is an event that says only "something changed".
      const before = await deps.prices.list()
      const after = await deps.prices.replaceAll(input.priceOverrides, deps.now())

      await deps.onPricesChanged?.()

      // The subject is the setting's name, not a row id: a setting has no row, and a stable name is
      // what keeps the console's subject filter able to separate one setting from another.
      await deps.audit.record({
        kind: AUDIT_KINDS.settingsChanged,
        subjectType: AUDIT_SUBJECTS.settings,
        subjectId: PRICE_OVERRIDES_SETTING,
        detail: priceOverrideAuditDetail(diffPriceOverrides(before, after)),
      })

      // Rendered from what the write returned rather than re-read: the row set is already in hand,
      // and a second read could disagree with what this request just stored.
      return ok(view(after))
    },

    tasks: async () => {
      // One reading of the clock for the whole screen: two would let one task be judged against a
      // later instant than the one beside it.
      const now = deps.now()
      const statuses = await Promise.all(
        // Driven off the Postgres enum, so a task that has never run still appears — a task
        // missing from this list is indistinguishable from one that is merely quiet.
        scheduledTask.enumValues.map(async (task) => {
          const [lastRun, lastSuccess] = await Promise.all([
            deps.scheduledTasks.lastRun(task),
            deps.scheduledTasks.lastSuccess(task),
          ])
          return toTaskStatusView({
            task,
            lastRun,
            lastSuccess,
            intervalMs: deps.intervals[task],
            now,
          })
        }),
      )
      return ok({ tasks: statuses })
    },

    audit: async (query) => {
      // `kind` has no repository predicate and services never write SQL, so it is applied after the
      // read. The scan is widened to the query's own maximum when a kind is asked for, which keeps
      // the filter useful without turning one indexed `LIMIT` into an unbounded scan; a search
      // deeper than that needs a repository method, not a loop in a service.
      const scan = query.kind === undefined ? query.limit : AUDIT_LIMIT_MAX
      const rows =
        query.subjectId === undefined
          ? await deps.auditEvents.list(scan)
          : await deps.auditEvents.listForSubject(query.subjectId, scan)

      const matched =
        query.kind === undefined ? rows : rows.filter((row) => row.kind === query.kind)
      return ok({ events: matched.slice(0, query.limit).map(toAuditEventView), limit: query.limit })
    },
  }
}
