import { QuotaWindowKind } from "@multi-ai-router/core"
import { z } from "zod"

/**
 * The two payloads the Agent SDK reports a subscription's limits in, validated into readings
 * (docs/idea/11-anthropic-agent-sdk.md §5). Pure: a value and a clock in, a reading or `null` out.
 * `quota.ts` folds readings into Account state; this file only decides what a payload said.
 *
 * - **`rate_limit_event`** rides the query stream and is an *alarm*: the SDK populates
 *   `utilization` only near the limit, so absence is the normal reading.
 * - **The usage gauge** is the structured answer behind the CLI's `/usage` command — the
 *   claude.ai plan-usage endpoint's per-window percentages, asked for through the SDK's own query
 *   object once a turn. It is *continuous*: every window it names carries a number, which is the
 *   second source §5 always described and the one `quota-aware` ranking can use.
 *
 * Zod at the boundary, tolerant by construction: both schemas are `looseObject`s whose every field
 * degrades to `null` on a shape surprise, because a field the SDK renames tomorrow must cost one
 * reading, never a turn — and the gauge is an API its own name says may change.
 */

export type SdkRateLimitStatus = "allowed" | "allowed_warning" | "rejected" | "unknown"

/** One `rate_limit_info` payload, validated. Absent fields stay absent — never defaulted to zero. */
export interface SdkRateLimitReading {
  readonly status: SdkRateLimitStatus
  /** The SDK's own word for the window, or null when it named none. */
  readonly rateLimitType: string | null
  /** Epoch instant the window refills, or null when none was reported or it had already passed. */
  readonly resetsAt: Date | null
  /** 0..1 spent, and only near the limit. */
  readonly utilization: number | null
  readonly overageStatus: string | null
  readonly overageResetsAt: Date | null
  readonly usingOverage: boolean
}

const nullableString = z.string().nullish().catch(null)
const nullableNumber = z.number().finite().nullish().catch(null)
const nullableBoolean = z.boolean().nullish().catch(null)

/**
 * Both spellings of every field, because the envelope around this payload is `snake_case`
 * (`rate_limit_info`, `parent_tool_use_id`) while §5 names its contents in `camelCase`. Accepting
 * one and silently dropping the other would read as "this account reported no limits" — the single
 * misreading that keeps traffic pointed at an upstream that already said no. `looseObject`, so a
 * field the SDK adds tomorrow survives the parse.
 */
const rateLimitInfoSchema = z.looseObject({
  status: nullableString,
  rateLimitType: nullableString,
  rate_limit_type: nullableString,
  resetsAt: nullableNumber,
  resets_at: nullableNumber,
  utilization: nullableNumber,
  overageStatus: nullableString,
  overage_status: nullableString,
  overageResetsAt: nullableNumber,
  overage_resets_at: nullableNumber,
  isUsingOverage: nullableBoolean,
  is_using_overage: nullableBoolean,
})

/** @returns null when the value is not a rate-limit payload at all. The caller skips it. */
export function readSdkRateLimitInfo(value: unknown, now: Date): SdkRateLimitReading | null {
  const parsed = rateLimitInfoSchema.safeParse(value)
  if (!parsed.success) return null
  const data = parsed.data

  return {
    status: readStatus(data.status),
    rateLimitType: nonEmpty(data.rateLimitType ?? data.rate_limit_type ?? null),
    resetsAt: futureEpoch(data.resetsAt ?? data.resets_at ?? null, now),
    utilization: data.utilization ?? null,
    overageStatus: nonEmpty(data.overageStatus ?? data.overage_status ?? null),
    overageResetsAt: futureEpoch(data.overageResetsAt ?? data.overage_resets_at ?? null, now),
    usingOverage: (data.isUsingOverage ?? data.is_using_overage) === true,
  }
}

/** One window as the usage gauge reports it. `utilization` is already 0..1 here, never a percent. */
export interface SdkGaugeWindow {
  readonly kind: QuotaWindowKind
  readonly utilization: number | null
  /** Null when none was reported, unparseable, or already in the past. */
  readonly resetsAt: Date | null
}

export interface SdkUsageGaugeReading {
  /**
   * False is the SDK saying plan limits do not apply here — an API key, Bedrock, or a login whose
   * OAuth scopes lack `user:profile`. Not a failure, and `windows` is then empty.
   */
  readonly available: boolean
  readonly subscriptionType: string | null
  /** Only windows this build knows how to render, and only the ones the endpoint actually named. */
  readonly windows: readonly SdkGaugeWindow[]
}

/**
 * The window keys the gauge may carry and the kinds they render as. Named rather than iterated off
 * the payload: `seven_day_oauth_apps` and `model_scoped` are real fields with no window kind in
 * this build, and inventing one would put an unrendered bucket into a console gauge.
 */
const GAUGE_WINDOW_KEYS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const

const gaugeWindowSchema = z
  .looseObject({
    // "Percentage of the window used, 0-100" — sdk.d.ts. Scaled below.
    utilization: nullableNumber,
    // "ISO 8601 timestamp when the window resets" — sdk.d.ts.
    resets_at: nullableString,
  })
  .nullish()
  .catch(null)

const usageGaugeSchema = z.looseObject({
  subscription_type: nullableString,
  rate_limits_available: nullableBoolean,
  rate_limits: z
    .looseObject({
      five_hour: gaugeWindowSchema,
      seven_day: gaugeWindowSchema,
      seven_day_opus: gaugeWindowSchema,
      seven_day_sonnet: gaugeWindowSchema,
    })
    .nullish()
    .catch(null),
})

/** @returns null when the value is not a usage payload at all. The caller logs and drops it. */
export function readSdkUsageGauge(value: unknown, now: Date): SdkUsageGaugeReading | null {
  const parsed = usageGaugeSchema.safeParse(value)
  if (!parsed.success) return null
  const data = parsed.data

  const limits = data.rate_limits ?? null
  const available = data.rate_limits_available === true && limits !== null
  const windows: SdkGaugeWindow[] = []
  if (available) {
    for (const key of GAUGE_WINDOW_KEYS) {
      const window = limits[key]
      if (window === null || window === undefined) continue
      windows.push({
        kind: QuotaWindowKind.parse(key),
        utilization:
          window.utilization === null || window.utilization === undefined
            ? null
            : clampFraction(window.utilization / 100),
        resetsAt: futureIso(window.resets_at, now),
      })
    }
  }

  return { available, subscriptionType: nonEmpty(data.subscription_type ?? null), windows }
}

function readStatus(value: string | null | undefined): SdkRateLimitStatus {
  if (value === "allowed" || value === "allowed_warning" || value === "rejected") return value
  return "unknown"
}

/**
 * The instant a window refills, in **whichever epoch unit the SDK used**, and only when it is still
 * ahead of us.
 *
 * **The SDK reports seconds.** Observed against a live subscription (SDK 0.3.220):
 * `rate_limit_info.resetsAt = 1785204600`, which is 2026-07-28T09:30:00Z as seconds and
 * 1970-01-21 as milliseconds. §5 says milliseconds and the type annotates no unit, so this read
 * both ways and took the wrong one — every Claude subscription reset was landing in 1970, failing
 * the "still ahead of us" test below, and being dropped as stale. The visible cost was the whole
 * subscription reset surface: no per-window countdown in the console, `resetSource: "unknown"`
 * rather than `provider-reported`, and a breaker that fell back to its estimated backoff while
 * holding the provider's own exact answer.
 *
 * Both units are accepted rather than the observed one pinned, using the same floor
 * `rate-limit/parse.ts` applies to OpenRouter's epoch header: anything below it cannot be a
 * plausible millisecond instant (it would be 1973 or earlier) and is therefore seconds. That way an
 * SDK that starts sending milliseconds tomorrow — matching what §5 always claimed — keeps working
 * instead of re-breaking this in the other direction.
 *
 * A reset genuinely in the past still answers nothing: passing it on would be worse than reporting
 * none, because the breaker would set a cooldown that has already elapsed — a cooldown of zero
 * against an upstream that just said no. Dropping it lets the backoff schedule take over, labelled
 * `estimated` rather than dressed up as the provider's own word.
 */
export const SDK_EPOCH_MILLIS_FLOOR = 100_000_000_000

function futureEpoch(epoch: number | null | undefined, now: Date): Date | null {
  if (epoch === null || epoch === undefined) return null
  if (!Number.isFinite(epoch) || epoch <= 0) return null
  const epochMs = epoch < SDK_EPOCH_MILLIS_FLOOR ? epoch * 1000 : epoch
  return epochMs > now.getTime() ? new Date(epochMs) : null
}

/** Same "still ahead of us" rule as {@link futureEpoch}, for the gauge's ISO 8601 timestamps. */
function futureIso(value: string | null | undefined, now: Date): Date | null {
  if (value === null || value === undefined) return null
  const epochMs = Date.parse(value)
  if (!Number.isFinite(epochMs)) return null
  return epochMs > now.getTime() ? new Date(epochMs) : null
}

/** `QuotaWindowState` admits 0..1 only. A provider overshoot reads as spent, which is the truth. */
export function clampFraction(value: number): number {
  return Math.min(Math.max(value, 0), 1)
}

function nonEmpty(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === "" ? null : trimmed
}
