import { describeError } from "@multi-ai-router/core"
import type { ScheduledTaskName } from "@multi-ai-router/db"
import { redactValue } from "../logging/redact"
import type { ScheduledTask } from "./types"

const MAX_ERROR_CHARS = 500

export function indexTasks(tasks: readonly ScheduledTask[]): Map<ScheduledTaskName, ScheduledTask> {
  const indexed = new Map<ScheduledTaskName, ScheduledTask>()
  for (const task of tasks) {
    if (indexed.has(task.name)) {
      // Two tasks under one name would share a lock key and silently serialize
      // against each other, which reads as "the second one never runs".
      throw new Error(`createScheduler: duplicate task name "${task.name}"`)
    }
    indexed.set(task.name, task)
  }
  return indexed
}

/**
 * Messages only — never a stack, never a query. This string is persisted and rendered.
 *
 * The whole `cause` chain, innermost first: a task failing on an ORM statement carries the
 * driver's complaint one `cause` down from a wrapper whose message *is* the statement text, and
 * front-anchored truncation of the wrapper alone persisted 500 chars of SQL with the actual
 * reason discarded. Redacted before the cap, so truncation cannot split a credential and leave
 * its tail in the persisted half.
 */
export function describe(error: unknown): string {
  const scrubbed = redactValue(describeError(error, Number.POSITIVE_INFINITY))
  return scrubbed.length <= MAX_ERROR_CHARS
    ? scrubbed
    : `${scrubbed.slice(0, MAX_ERROR_CHARS - 1)}…`
}
