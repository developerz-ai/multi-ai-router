import { formatRelative } from "../format"
import { request } from "./client"

// `/api/admin/tasks` — the latest run of every scheduled task.
//
// Background work is in-process jittered timers coordinated by Postgres advisory
// locks, so **a task that silently stops running is the failure this endpoint
// exists to catch** (docs/idea/08-observability.md#scheduled-task-visibility).
// Everything below turns a run row into the sentence the console prints, and
// takes `nowMs` from the caller rather than reading a clock.
//
// Nothing here predicts the *next* run. Intervals are jittered and only the
// replica holding the lock runs a task, so a countdown would be a guess dressed
// as a fact.

export type TaskHealth = "ok" | "running" | "stale" | "failing" | "never_run"
export type TaskOutcome = "success" | "partial" | "failed"

export interface TaskRun {
  readonly startedAt: string
  /** Null while the run is still in flight. */
  readonly finishedAt: string | null
  readonly outcome: TaskOutcome | null
  readonly itemsProcessed: number
  /** The failure's own words when the last run failed. Never a stack trace. */
  readonly error: string | null
}

export interface TaskHealthRow {
  /** The scheduler's name for the task. A string, not a union: the task list is a db enum. */
  readonly task: string
  readonly intervalMinutes: number
  readonly health: TaskHealth
  readonly lastRun: TaskRun | null
  readonly lastSuccessAt: string | null
}

/** The `scheduled_task` Postgres enum, spelled for a human. Adding a task adds a key here. */
const TASK_LABELS: Readonly<Record<string, string>> = {
  janitor_sweep: "Janitor",
  usage_rollup: "Usage rollup",
  oauth_state_purge: "OAuth state purge",
  quota_floor_refresh: "Quota floor refresh",
  config_dir_reap: "Orphaned config directory reap",
}

/** An unknown name is humanised, never dropped — a task added upstream must still render. */
export function taskLabel(task: string): string {
  const known = TASK_LABELS[task]
  if (known !== undefined) return known
  const words = task.replace(/[_-]+/g, " ").trim()
  return words.length === 0 ? "Unnamed task" : `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

const TASK_ITEMS: Readonly<Record<string, string>> = {
  janitor_sweep: "rows deleted",
  usage_rollup: "records rolled up",
  oauth_state_purge: "rows deleted",
  quota_floor_refresh: "accounts refreshed",
  config_dir_reap: "directories removed",
}

/** What this task's `itemsProcessed` counts, so the sentence reads like English. */
export function taskItemsLabel(task: string): string {
  return TASK_ITEMS[task] ?? "items processed"
}

export function taskHealthLabel(health: TaskHealth): string {
  switch (health) {
    case "ok":
      return "Running on schedule"
    case "running":
      return "Running right now"
    case "stale":
      return "No successful run in longer than its interval — it may have stopped"
    case "failing":
      return "The last run failed"
    case "never_run":
      return "Has not run since this router started"
  }
}

export type TaskTone = "ok" | "accent" | "warn" | "danger"

export function taskHealthTone(health: TaskHealth): TaskTone {
  switch (health) {
    case "ok":
      return "ok"
    case "running":
      return "accent"
    case "stale":
    case "never_run":
      return "warn"
    case "failing":
      return "danger"
  }
}

/** The three states worth interrupting an operator for. `running` is not one of them. */
export function needsAttention(health: TaskHealth): boolean {
  return health === "stale" || health === "failing" || health === "never_run"
}

/**
 * The plain-language line the spec asks for — *"Janitor last ran 4 min ago, 812
 * rows deleted"*. A task that has never run says exactly that: no relative time,
 * no timestamp, nothing shaped like an observation nobody made.
 */
export function describeTaskRun(row: TaskHealthRow, nowMs: number): string {
  const name = taskLabel(row.task)
  const run = row.lastRun
  if (run === null) return `${name} has not run yet.`

  const when = formatRelative(run.startedAt, nowMs)
  if (run.finishedAt === null) return `${name} started ${when} and is still running.`

  const items = `${run.itemsProcessed} ${taskItemsLabel(row.task)}`
  if (run.outcome === "failed") return `${name} last ran ${when} and failed after ${items}.`
  if (run.outcome === "partial") return `${name} last ran ${when} and stopped part-way, ${items}.`
  return `${name} last ran ${when}, ${items}.`
}

export async function fetchTasks(): Promise<readonly TaskHealthRow[]> {
  const body = await request<{ readonly tasks: readonly TaskHealthRow[] }>({
    method: "GET",
    path: "/tasks",
  })
  return body.tasks
}
