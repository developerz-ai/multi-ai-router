import { ProviderId } from "@multi-ai-router/core"
import type {
  AuditEventRow,
  PriceOverrideRow,
  ScheduledTaskName,
  ScheduledTaskOutcome,
} from "@multi-ai-router/db"
import { z } from "zod"
import type { LogLevel, RetentionConfig } from "../../config/env"

/**
 * The settings screen's wire contract: what it reads, the one thing it may write, and the shape
 * every rate on it takes.
 *
 * **Retention, log level and the janitor interval are read-only here on purpose.** All three are
 * environment configuration (CLAUDE.md non-negotiable 11), so this surface shows them and says
 * where they are set; a write path would be a second source of truth for a value the process only
 * reads at boot. `RetentionConfig` is reused rather than restated for the same reason — a view that
 * *is* the env's type cannot drift from the env it renders.
 *
 * The price overrides are the one writable thing, and they are written as a whole set. The console
 * edits the table as one object, exactly as pool membership is replaced rather than patched
 * (`services/pools/schemas.ts`): a set applied row by row is briefly half-applied, and half a price
 * table prices a report at rates nobody chose. An empty array is therefore meaningful — it clears
 * every override and returns the deployment to the shipped table.
 */

/**
 * Ceiling on one write. Not a tuning knob: it is the bound that stops a single request writing an
 * unbounded table, the same role the `.max(200)` on pool membership plays.
 */
export const MAX_PRICE_OVERRIDES = 500

/**
 * US dollars per million tokens. `z.number()` already refuses NaN and Infinity, so the two bounds
 * are the whole rule: a negative price is not a discount, and the ceiling is far above any real
 * published rate while staying inside the `numeric(12, 6)` column that stores it.
 */
const RATE = z.number().min(0).max(10_000)

/**
 * Normalized on the way in — trimmed and lowercased — because that is how the price book looks a
 * model up and how the unique index on `(provider, model)` is defined. Two casings of one model
 * would otherwise both store and only one would ever be found.
 */
const MODEL = z.string().trim().toLowerCase().min(1).max(200)

/** `provider` is core's own schema, never a restated list: the Postgres enum is built from it. */
export const priceOverrideInput = z
  .object({
    provider: ProviderId,
    model: MODEL,
    inputPerMtok: RATE,
    outputPerMtok: RATE,
    cacheReadPerMtok: RATE,
    cacheWritePerMtok: RATE,
  })
  .strict()

export const updatePriceOverridesBody = z
  .object({
    /** The complete set. Whatever is stored is replaced by this, and `[]` clears it. */
    priceOverrides: z.array(priceOverrideInput).max(MAX_PRICE_OVERRIDES),
  })
  .strict()
  .superRefine((body, ctx) => {
    // After normalization, so `Claude-Sonnet-5` and `claude-sonnet-5` collide here rather than at
    // the unique index — where the failure would be a 500 that names a constraint, not a model.
    const seen = new Set<string>()
    for (const [index, row] of body.priceOverrides.entries()) {
      const pair = `${row.provider}/${row.model}`
      if (seen.has(pair)) {
        ctx.addIssue({
          code: "custom",
          path: ["priceOverrides", index],
          message: `"${pair}" is listed twice: one rate per provider and model`,
        })
      }
      seen.add(pair)
    }
  })

export type UpdatePriceOverridesInput = z.infer<typeof updatePriceOverridesBody>

export const AUDIT_LIMIT_DEFAULT = 50
export const AUDIT_LIMIT_MIN = 1
export const AUDIT_LIMIT_MAX = 200

/**
 * Query params arrive as strings, so `limit` is coerced; everything else is validated exactly as
 * `usageWindowQuery` validates the usage screen's window. Out of range is a 400 rather than a
 * silent clamp — a console that asked for 1000 rows and got 200 without being told would render a
 * truncated page as a complete one.
 */
export const auditQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(AUDIT_LIMIT_MIN)
    .max(AUDIT_LIMIT_MAX)
    .default(AUDIT_LIMIT_DEFAULT),
  /** Every audit subject is a database uuid; anything else cannot name one. */
  subjectId: z.uuid().optional(),
  kind: z.string().trim().min(1).max(120).optional(),
})

export type AuditQuery = z.infer<typeof auditQuery>

export interface PriceRateView {
  readonly provider: ProviderId
  readonly model: string
  readonly inputPerMtok: number
  readonly outputPerMtok: number
  readonly cacheReadPerMtok: number
  readonly cacheWritePerMtok: number
}

export interface PriceOverrideView extends PriceRateView {
  readonly updatedAt: string
}

export interface PricesView {
  /** The table shipped in the image. Read-only: it changes when the image does. */
  readonly shipped: readonly PriceRateView[]
  /** What the operator layered over it. An entry here wins for the pair it names, and nothing else. */
  readonly overrides: readonly PriceOverrideView[]
}

export interface SettingsView {
  readonly retention: RetentionConfig
  readonly logLevel: LogLevel
  readonly janitorIntervalMinutes: number
  readonly prices: PricesView
}

export interface TaskRunView {
  readonly startedAt: string
  /** Null while the run is open — and still null long after, on a run that was killed halfway. */
  readonly finishedAt: string | null
  readonly outcome: ScheduledTaskOutcome | null
  readonly itemsProcessed: number
  /** Already redacted and truncated by the scheduler. Passed through, never re-rendered. */
  readonly error: string | null
}

export interface TaskStatusView {
  readonly task: ScheduledTaskName
  readonly intervalMinutes: number
  readonly health: TaskHealth
  /** Null when the task has never run at all — which is itself the `never_run` health. */
  readonly lastRun: TaskRunView | null
  readonly lastSuccessAt: string | null
}

export interface TaskHealthView {
  readonly tasks: readonly TaskStatusView[]
}

/**
 * What an operator needs to tell apart at a glance. `stale` is the one this surface exists for: a
 * task that silently stopped running looks identical to a healthy one on every other signal.
 */
export type TaskHealth = "ok" | "running" | "stale" | "failing" | "never_run"

export interface AuditEventView {
  readonly id: string
  readonly kind: string
  readonly subjectType: string | null
  readonly subjectId: string | null
  readonly detail: Record<string, unknown> | null
  readonly createdAt: string
}

export interface AuditView {
  readonly events: readonly AuditEventView[]
  /** Echoed back so the console can say how deep the page it is showing goes. */
  readonly limit: number
}

/** The six rate fields and nothing else — a shipped row and a stored row both narrow through here. */
export function toPriceRateView(rate: PriceRateView): PriceRateView {
  return {
    provider: rate.provider,
    model: rate.model,
    inputPerMtok: rate.inputPerMtok,
    outputPerMtok: rate.outputPerMtok,
    cacheReadPerMtok: rate.cacheReadPerMtok,
    cacheWritePerMtok: rate.cacheWritePerMtok,
  }
}

export function toPriceOverrideView(row: PriceOverrideRow): PriceOverrideView {
  return { ...toPriceRateView(row), updatedAt: row.updatedAt.toISOString() }
}

export function toAuditEventView(row: AuditEventRow): AuditEventView {
  return {
    id: row.id,
    kind: row.kind,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    // Written through the tested redactor, so it is already free of credential material.
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  }
}
