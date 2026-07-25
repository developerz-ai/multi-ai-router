import { Show } from "solid-js"
import { Badge } from "../../components/Badge"
import { Banner } from "../../components/Banner"
import { EmptyState } from "../../components/EmptyState"
import { QueryBoundary } from "../../components/QueryBoundary"
import { type Column, Table } from "../../components/Table"
import { TableSkeleton } from "../../components/TableSkeleton"
import {
  describeTaskRun,
  needsAttention,
  type TaskHealthRow,
  taskHealthLabel,
  taskHealthTone,
  taskItemsLabel,
  taskLabel,
} from "../../lib/api/tasks"
import { createNow } from "../../lib/clock"
import { formatCount, formatRelative, formatTimestamp } from "../../lib/format"
import { useTasks } from "../../lib/queries/settings"
import styles from "./TaskHealthSection.module.scss"

/**
 * The latest run per scheduled task, in plain language.
 *
 * The failure this exists to catch is a task that **silently stopped** — so a
 * `stale`, `failing` or `never_run` task is called out in a banner and in its own
 * row rather than left for the reader to infer from a timestamp
 * (docs/idea/08-observability.md#scheduled-task-visibility).
 *
 * Nothing here counts *down*. The scheduler jitters its intervals and coordinates
 * by advisory lock, so "next run in 12m" would be a prediction, not a fact; a task
 * that has never run gets no timestamp at all rather than a plausible-looking one.
 */
export function TaskHealthSection() {
  const tasks = useTasks()
  const now = createNow(30_000)

  const columns = (): readonly Column<TaskHealthRow>[] => [
    {
      id: "task",
      header: "Task",
      cell: (row) => (
        <div class={styles.identity}>
          <span class={styles.name}>{taskLabel(row.task)}</span>
          <span class={styles.sub}>every {row.intervalMinutes} min</span>
        </div>
      ),
    },
    {
      id: "health",
      header: "Health",
      cell: (row) => (
        <Badge title={taskHealthLabel(row.health)} tone={taskHealthTone(row.health)}>
          {row.health.replace("_", " ")}
        </Badge>
      ),
    },
    {
      id: "what",
      header: "What happened",
      cell: (row) => (
        <div class={styles.identity}>
          <span>{describeTaskRun(row, now())}</span>
          <Show when={needsAttention(row.health)}>
            <span class={styles.attention}>{taskHealthLabel(row.health)}</span>
          </Show>
          <Show when={row.lastRun?.error}>
            {(error) => (
              <span class={styles.error} role="alert">
                {error()}
              </span>
            )}
          </Show>
        </div>
      ),
    },
    {
      id: "lastRun",
      header: "Last run",
      cell: (row) => (
        <Show fallback={<span class={styles.sub}>never</span>} when={row.lastRun}>
          {(run) => (
            <div class={styles.identity}>
              <span>{formatTimestamp(run().startedAt)}</span>
              <span class={styles.sub}>{formatRelative(run().startedAt, now())}</span>
            </div>
          )}
        </Show>
      ),
    },
    {
      id: "lastSuccess",
      header: "Last success",
      cell: (row) => (
        <Show fallback={<span class={styles.sub}>never</span>} when={row.lastSuccessAt}>
          {(at) => (
            <div class={styles.identity}>
              <span>{formatTimestamp(at())}</span>
              <span class={styles.sub}>{formatRelative(at(), now())}</span>
            </div>
          )}
        </Show>
      ),
    },
    {
      id: "items",
      header: "Items",
      numeric: true,
      cell: (row) => (
        <Show fallback="—" when={row.lastRun}>
          {(run) => (
            <span title={taskItemsLabel(row.task)}>{formatCount(run().itemsProcessed)}</span>
          )}
        </Show>
      ),
    },
  ]

  return (
    <section aria-labelledby="tasks-heading" class={styles.section}>
      <h2 class={styles.heading} id="tasks-heading">
        Background tasks
      </h2>

      <QueryBoundary
        errorTitle="Task health could not be loaded"
        loading={<TableSkeleton label="Loading task health" rows={4} />}
        query={tasks}
      >
        {(rows) => (
          <Show
            fallback={
              <EmptyState
                description="The scheduler has registered no tasks in this process. That is itself worth checking: retention sweeps, the usage rollup and the OAuth state purge all run here."
                icon="settings"
                title="No scheduled tasks"
              />
            }
            when={rows.length > 0}
          >
            <Show when={attention(rows)}>
              {(troubled) => (
                <Banner
                  title={`${troubled().length} background task${troubled().length === 1 ? "" : "s"} need attention`}
                  tone={troubled().some((row) => row.health === "failing") ? "danger" : "warn"}
                >
                  {troubled()
                    .map((row) => `${taskLabel(row.task)}: ${taskHealthLabel(row.health)}`)
                    .join(" · ")}
                </Banner>
              )}
            </Show>

            <Table
              caption="One row per scheduled task. Runs are recorded as they settle; exactly one replica holds each task's advisory lock, so a skipped run on another replica is not a failure."
              columns={columns()}
              rowId={(row) => row.task}
              rows={rows}
            />
          </Show>
        )}
      </QueryBoundary>
    </section>
  )
}

/** Null rather than an empty array, so `<Show>` renders the banner only when there is one to show. */
function attention(rows: readonly TaskHealthRow[]): readonly TaskHealthRow[] | null {
  const troubled = rows.filter((row) => needsAttention(row.health))
  return troubled.length === 0 ? null : troubled
}
