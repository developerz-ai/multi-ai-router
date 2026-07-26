import type {
  AuditEventRow,
  PriceOverrideInput,
  PriceOverrideRow,
  ScheduledTaskName,
  ScheduledTaskOutcome,
  ScheduledTaskRunRow,
} from "@multi-ai-router/db"
import type { RetentionConfig } from "../../../src/config/env"
import { createSettingsService, type SettingsService } from "../../../src/services/settings"

/**
 * Doubles for the settings service's four dependencies, none of which is a mock: each one
 * implements the real interface over an array, so a test asserts on the rows the service actually
 * wrote rather than on which methods it happened to call — the house pattern
 * (`apps/api/test/support/memory-store.ts`).
 *
 * Everything the service reads a clock or an environment for is injected, so every test here is a
 * pure function of its fixtures.
 */

export const NOW = new Date("2026-07-25T12:00:00.000Z")
export const MINUTE_MS = 60_000

/** Deliberately not the shipped defaults: a view that hard-coded them would still pass. */
export const RETENTION: RetentionConfig = {
  sessionsHours: 12,
  usageDays: 45,
  auditDays: 180,
  revokedKeysDays: 15,
  oauthStateMinutes: 7,
}

/** What `scheduledTaskIntervals(env)` returns — the same map the running tasks are built from. */
export const INTERVALS: Readonly<Record<ScheduledTaskName, number>> = {
  janitor_sweep: 60 * MINUTE_MS,
  usage_rollup: 60 * MINUTE_MS,
  oauth_state_purge: 5 * MINUTE_MS,
  quota_floor_refresh: 30 * MINUTE_MS,
}

export interface MemoryPrices {
  readonly rows: PriceOverrideRow[]
  list(): Promise<PriceOverrideRow[]>
  replaceAll(rows: readonly PriceOverrideInput[], now: Date): Promise<PriceOverrideRow[]>
}

/** Provider then model, the order the real repository's `ORDER BY` fixes. */
function ordered(rows: readonly PriceOverrideRow[]): PriceOverrideRow[] {
  return [...rows].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
  )
}

export function memoryPrices(seed: readonly PriceOverrideInput[] = []): MemoryPrices {
  const rows: PriceOverrideRow[] = seed.map((row, index) => toRow(row, index, NOW))
  const store = {
    rows,
    list: async () => ordered(rows),
    replaceAll: async (next: readonly PriceOverrideInput[], now: Date) => {
      rows.length = 0
      rows.push(...next.map((row, index) => toRow(row, index, now)))
      return ordered(rows)
    },
  }
  return store
}

function toRow(input: PriceOverrideInput, index: number, at: Date): PriceOverrideRow {
  return { id: `price-${index}`, ...input, createdAt: at, updatedAt: at }
}

export type TaskRuns = Partial<Record<ScheduledTaskName, readonly ScheduledTaskRunRow[]>>

export function memoryTasks(runs: TaskRuns = {}) {
  const newest = (rows: readonly ScheduledTaskRunRow[]): ScheduledTaskRunRow | undefined =>
    [...rows].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0]
  return {
    lastRun: async (task: ScheduledTaskName) => newest(runs[task] ?? []),
    lastSuccess: async (task: ScheduledTaskName) =>
      newest((runs[task] ?? []).filter((row) => row.outcome === "success")),
  }
}

export interface RunOptions {
  readonly startedAt: Date
  readonly finishedAt?: Date | null
  readonly outcome?: ScheduledTaskOutcome | null
  readonly itemsProcessed?: number
  readonly error?: string | null
}

export function run(options: RunOptions): ScheduledTaskRunRow {
  return {
    id: `run-${options.startedAt.toISOString()}`,
    task: "janitor_sweep",
    startedAt: options.startedAt,
    finishedAt: options.finishedAt ?? null,
    outcome: options.outcome ?? null,
    itemsProcessed: options.itemsProcessed ?? 0,
    error: options.error ?? null,
  }
}

export function event(options: {
  readonly id: string
  readonly kind: string
  readonly createdAt: Date
  readonly subjectId?: string | null
  readonly detail?: Record<string, unknown> | null
}): AuditEventRow {
  return {
    id: options.id,
    kind: options.kind,
    subjectType: options.subjectId === undefined ? null : "account",
    subjectId: options.subjectId ?? null,
    detail: options.detail ?? null,
    createdAt: options.createdAt,
  }
}

export function memoryAuditLog(rows: readonly AuditEventRow[]) {
  const newestFirst = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  return {
    list: async (limit: number) => newestFirst.slice(0, limit),
    listForSubject: async (subjectId: string, limit: number) =>
      newestFirst.filter((row) => row.subjectId === subjectId).slice(0, limit),
  }
}

export interface RecordedAudit {
  readonly kind: string
  readonly subjectType: string
  readonly subjectId: string
  readonly detail?: Record<string, unknown>
}

export function recordingAudit(onRecord: () => void = () => undefined) {
  const events: RecordedAudit[] = []
  return {
    events,
    record: async (recorded: RecordedAudit) => {
      events.push(recorded)
      onRecord()
    },
  }
}

export interface HarnessOptions {
  readonly prices?: readonly PriceOverrideInput[]
  readonly runs?: TaskRuns
  readonly auditLog?: readonly AuditEventRow[]
  readonly onPricesChanged?: () => Promise<void>
  readonly onAudit?: () => void
  readonly now?: Date
  /** Defaults to null — most fixtures exercise the no-`PUBLIC_URL` deployment. */
  readonly publicUrl?: string | null
}

export interface Harness {
  readonly service: SettingsService
  readonly prices: MemoryPrices
  readonly audit: ReturnType<typeof recordingAudit>
}

export function harness(options: HarnessOptions = {}): Harness {
  const prices = memoryPrices(options.prices)
  const audit = recordingAudit(options.onAudit)
  const service = createSettingsService({
    prices,
    scheduledTasks: memoryTasks(options.runs),
    auditEvents: memoryAuditLog(options.auditLog ?? []),
    audit,
    env: {
      retention: RETENTION,
      logLevel: "warn",
      janitorIntervalMinutes: 42,
      publicUrl: options.publicUrl ?? null,
    },
    intervals: INTERVALS,
    now: () => options.now ?? NOW,
    ...(options.onPricesChanged === undefined ? {} : { onPricesChanged: options.onPricesChanged }),
  })
  return { service, prices, audit }
}

/** Flushes the microtask queue far enough that a promise blocked on nothing would have settled. */
export async function flush(): Promise<void> {
  for (let tick = 0; tick < 32; tick += 1) await Promise.resolve()
}
