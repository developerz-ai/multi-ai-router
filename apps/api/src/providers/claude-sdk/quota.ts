import {
  QuotaWindowKind,
  type QuotaWindowState,
  type ResetSource,
  type UtilizationSource,
} from "@multi-ai-router/core"
import { z } from "zod"
import type { RateLimitSignal, RateLimitWindow } from "../types"

/**
 * `rate_limit_event` in, Account quota state out (docs/idea/11-anthropic-agent-sdk.md §5).
 *
 * The SDK reports its limits inside the query stream rather than in a response header, which is why
 * this exists at all: an HTTP account's headroom is parsed off the response it just answered
 * (`rate-limit/parse.ts`), and a subscription's rides a message the client must never see. Same
 * destination, two sources — a `RateLimitSignal` the health store folds in exactly as it folds in an
 * HTTP one, so `cooling_down`, `Retry-After`, and the breaker are written once for both transports.
 *
 * Three properties are load-bearing:
 *
 * - **`utilization` is an alarm, not a gauge.** The SDK populates it only near the limit, so it
 *   reads absent for most of every window. That is a normal reading and it is labelled as one:
 *   `utilizationSource` is `threshold-triggered` whenever a value is present, which is precisely
 *   what stops `quota-aware` from ranking accounts on an absence (`services/routing/quota.ts`).
 * - **An event that named no window still counts.** A `rejected` with no `rateLimitType` is the
 *   account saying "not now", so it lands in an internal `default` bucket and cools the account
 *   down — but it is never rendered as a real window, because naming which window was spent would
 *   be inventing the one fact the event withheld. A window kind this build does not know lands in
 *   its own unrendered bucket for the same reason, under the SDK's own word for it.
 * - **Never a process singleton.** State is per-runtime and keyed by Account, exactly like the
 *   health store: a module-level map would bleed one runtime's readings into another's inside a
 *   single process, and every test would start dirty.
 *
 * Absent until a caller exists, mirroring the driver's own omissions: enumeration for `/metrics` and
 * the admin console, and the OAuth usage endpoint that would supply the *continuous* second source
 * §5 describes. Both are additive; neither is faked here.
 */

/** The bucket an event that named no window lands in. Never rendered as a `QuotaWindowState`. */
export const SDK_DEFAULT_BUCKET = "default"

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

export interface SdkQuotaSnapshot {
  /** The windows a console renders. Unknown and unnamed buckets are absent by construction. */
  readonly windows: readonly QuotaWindowState[]
  /** The reading the health store folds in — identical in shape to an HTTP driver's. */
  readonly signal: RateLimitSignal
  /** The account is currently spending paid overage rather than its included allowance. */
  readonly usingOverage: boolean
}

export interface SdkQuotaStore {
  /**
   * Folds one `rate_limit_event` payload into this Account's state.
   *
   * @returns the Account's whole reading afterwards, or null when the payload was unreadable — a
   * malformed event costs this update and nothing else, exactly as one unreadable SDK message costs
   * one frame rather than the turn (`render/events.ts`).
   */
  ingest(accountId: string, info: unknown, now: Date): SdkQuotaSnapshot | null
  /** The Account's current reading, or null when it has never reported one. */
  snapshot(accountId: string): SdkQuotaSnapshot | null
  /** Drops every reading for an Account — deletion, and the operator's "Re-check now". */
  forget(accountId: string): void
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
    resetsAt: futureInstant(data.resetsAt ?? data.resets_at ?? null, now),
    utilization: data.utilization ?? null,
    overageStatus: nonEmpty(data.overageStatus ?? data.overage_status ?? null),
    overageResetsAt: futureInstant(data.overageResetsAt ?? data.overage_resets_at ?? null, now),
    usingOverage: (data.isUsingOverage ?? data.is_using_overage) === true,
  }
}

export function createSdkQuotaStore(): SdkQuotaStore {
  const accounts = new Map<string, AccountQuota>()

  return {
    ingest(accountId, info, now) {
      const reading = readSdkRateLimitInfo(info, now)
      if (reading === null) return null

      const state = accounts.get(accountId) ?? { buckets: new Map(), usingOverage: false }
      accounts.set(accountId, state)

      const key = reading.rateLimitType ?? SDK_DEFAULT_BUCKET
      state.buckets.set(key, {
        limiter: key,
        kind: windowKind(reading.rateLimitType),
        limited: reading.status === "rejected",
        utilization: clampUtilization(reading.utilization),
        resetsAt: reading.resetsAt ?? undefined,
        lastCheckedAt: now,
      })
      state.usingOverage = reading.usingOverage
      applyOverage(state, reading, key, now)

      return snapshotOf(state)
    },

    snapshot(accountId) {
      const state = accounts.get(accountId)
      return state === undefined ? null : snapshotOf(state)
    },

    forget(accountId) {
      accounts.delete(accountId)
    },
  }
}

interface QuotaBucket {
  /** The provider's own word for the window, kept verbatim — `RateLimitWindow` is free-form. */
  readonly limiter: string
  /** Null for the `default` bucket and for a window kind this build does not know. */
  readonly kind: QuotaWindowKind | null
  readonly limited: boolean
  readonly utilization: number | undefined
  readonly resetsAt: Date | undefined
  readonly lastCheckedAt: Date
}

interface AccountQuota {
  readonly buckets: Map<string, QuotaBucket>
  usingOverage: boolean
}

/**
 * The paid-overage window, recorded from the detail every event carries beside its own window.
 *
 * It is never `limited`, and that is the whole subtlety: a rejected overage means the *paid* top-up
 * is unavailable, not that this request cannot be served. An account whose five-hour window is fine
 * serves normally with no overage at all, so letting this bucket block one would take a healthy
 * account out of the pool. Whichever included window actually rejected the request is what does it.
 */
function applyOverage(
  state: AccountQuota,
  reading: SdkRateLimitReading,
  key: string,
  now: Date,
): void {
  // The event named the overage window itself, so its own bucket already holds the reading —
  // including a `rejected` status this function would otherwise flatten.
  if (key === "overage") return
  if (reading.overageStatus === null && reading.overageResetsAt === null && !reading.usingOverage) {
    return
  }

  state.buckets.set("overage", {
    limiter: "overage",
    kind: "overage",
    limited: false,
    utilization: undefined,
    resetsAt: reading.overageResetsAt ?? undefined,
    lastCheckedAt: now,
  })
}

function snapshotOf(state: AccountQuota): SdkQuotaSnapshot {
  const windows: QuotaWindowState[] = []
  const limiterWindows: RateLimitWindow[] = []
  let limited = false
  let resetsAt: Date | undefined

  for (const bucket of state.buckets.values()) {
    const reading = {
      utilizationSource: utilizationSourceOf(bucket),
      resetSource: resetSourceOf(bucket),
      ...(bucket.utilization === undefined ? {} : { utilization: bucket.utilization }),
      ...(bucket.resetsAt === undefined ? {} : { resetsAt: bucket.resetsAt }),
    }

    if (bucket.kind !== null) {
      windows.push({ window: bucket.kind, lastCheckedAt: bucket.lastCheckedAt, ...reading })
    }
    limiterWindows.push({ limiter: bucket.limiter, ...reading })

    if (!bucket.limited) continue
    limited = true
    if (bucket.resetsAt !== undefined && (resetsAt === undefined || bucket.resetsAt < resetsAt)) {
      resetsAt = bucket.resetsAt
    }
  }

  return {
    windows,
    usingOverage: state.usingOverage,
    signal: {
      limited,
      // Only a *blocking* window's reset answers "when may this account serve again", so a reset
      // borrowed from a window that is merely warning would understate the cooldown.
      resetSource: resetsAt === undefined ? "unknown" : "provider-reported",
      windows: limiterWindows,
      // The named windows ride the signal because that is how they reach Account state: the health
      // store folds one reading in, from either transport, and the console's gauges and the
      // filter's `quota-window-spent` read what it folded. Omitted rather than sent empty when this
      // account has reported only unnamed buckets — `[]` would claim it holds no windows at all,
      // and on a fresh process that claim would overwrite what the last one persisted.
      ...(windows.length === 0 ? {} : { quotaWindows: windows }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    },
  }
}

/** Always threshold-triggered when present: §5's caveat, carried on the row rather than assumed. */
function utilizationSourceOf(bucket: QuotaBucket): UtilizationSource {
  return bucket.utilization === undefined ? "none" : "threshold-triggered"
}

function resetSourceOf(bucket: QuotaBucket): ResetSource {
  return bucket.resetsAt === undefined ? "unknown" : "provider-reported"
}

function readStatus(value: string | null | undefined): SdkRateLimitStatus {
  if (value === "allowed" || value === "allowed_warning" || value === "rejected") return value
  return "unknown"
}

/** Zod validated the shape, not the vocabulary; an unknown kind is a bucket, never a window. */
function windowKind(raw: string | null): QuotaWindowKind | null {
  if (raw === null) return null
  const parsed = QuotaWindowKind.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * Epoch **milliseconds** per §5, and only when the instant is still ahead of us.
 *
 * A reset already in the past answers nothing — it is late delivery, clock skew, or a value the SDK
 * reported in seconds — and passing it on would be worse than reporting none: the breaker would set
 * a cooldown that has already elapsed, which is a cooldown of zero against an upstream that just
 * said no. Dropping it lets the backoff schedule take over, labelled `estimated` rather than dressed
 * up as the provider's own word.
 */
function futureInstant(epochMs: number | null | undefined, now: Date): Date | null {
  if (epochMs === null || epochMs === undefined) return null
  return epochMs > now.getTime() ? new Date(epochMs) : null
}

/** `QuotaWindowState` admits 0..1 only. A provider overshoot reads as spent, which is the truth. */
function clampUtilization(value: number | null): number | undefined {
  if (value === null) return undefined
  return Math.min(Math.max(value, 0), 1)
}

function nonEmpty(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === "" ? null : trimmed
}
