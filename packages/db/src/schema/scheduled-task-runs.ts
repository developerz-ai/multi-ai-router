import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { scheduledTask, scheduledTaskOutcome } from "./enums"

/**
 * One row per run of a periodic task. Background work is in-process and
 * coordinated by a Postgres advisory lock per task, so this row is how anyone
 * knows a sweep happened at all: a replica that fails the lock writes nothing,
 * and a wedged task shows as a stale `startedAt` with a NULL `finishedAt`
 * instead of failing silently.
 *
 * Deliberately persisted — an in-memory last-run record dies with the process
 * that wedged.
 */
export const scheduledTaskRuns = pgTable(
  "scheduled_task_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    task: scheduledTask("task").notNull(),

    /** Set when the advisory lock is acquired. */
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    /** NULL while running — and still NULL long after, on a run that was killed halfway. */
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),

    /** NULL while running. `partial` means the batch limit was hit; the next run continues. */
    outcome: scheduledTaskOutcome("outcome"),

    /** Rows deleted or aggregated, in the task's own unit. */
    itemsProcessed: integer("items_processed").notNull().default(0),

    /** Message only, redacted. Never credential material. */
    error: text("error"),
  },
  (table) => [
    index("scheduled_task_runs_task_started_idx").on(table.task, table.startedAt),
    // The retention sweep drains oldest-first across every task at once, which the composite
    // index above cannot serve: it is ordered by task before age, so a global "oldest N" is a
    // sort of the whole table.
    index("scheduled_task_runs_started_at_idx").on(table.startedAt),
  ],
)

export type ScheduledTaskRunRow = typeof scheduledTaskRuns.$inferSelect
export type NewScheduledTaskRunRow = typeof scheduledTaskRuns.$inferInsert
