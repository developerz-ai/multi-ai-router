import type {
  QuotaWindowKind,
  QuotaWindowState,
  ResetSource,
  UtilizationSource,
} from "@multi-ai-router/core"
import { QuotaWindowKind as QuotaWindowKindSchema } from "@multi-ai-router/core"
import type { RateLimitWindow } from "../types"
import type { SdkQuotaSnapshot } from "./quota"
import { MODEL_SCOPED_WINDOWS, type SdkRateLimitReading } from "./quota-reading"

/**
 * One Account's per-window buckets and what they add up to — pure, beside the store that holds them
 * (`quota.ts`): how paid overage is recorded, when a refusal is over, and which refusals are the
 * Account's verdict rather than one model family's.
 */

/** The bucket an event that named no window lands in. Never rendered as a `QuotaWindowState`. */
export const SDK_DEFAULT_BUCKET = "default"

export interface QuotaBucket {
  /** The provider's own word for the window, kept verbatim — `RateLimitWindow` is free-form. */
  readonly limiter: string
  /** Null for the `default` bucket and for a window kind this build does not know. */
  readonly kind: QuotaWindowKind | null
  readonly limited: boolean
  readonly utilization: number | undefined
  /** Which reading `utilization` came from. `none` whenever it is undefined. */
  readonly source: UtilizationSource
  readonly resetsAt: Date | undefined
  readonly lastCheckedAt: Date
}

export interface AccountQuota {
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
export function applyOverage(
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
    source: "none",
    resetsAt: reading.overageResetsAt ?? undefined,
    lastCheckedAt: now,
  })
}

/**
 * `verdict` is the event path: a `limited` bucket cools the account down through the breaker.
 * `reading` is the gauge path: the same windows, but the signal never claims a refusal the gauge
 * did not make — the health store's fold would otherwise re-record a rate-limit failure per gauge.
 */
export function snapshotOf(
  state: AccountQuota,
  mode: "verdict" | "reading",
  now: Date,
): SdkQuotaSnapshot {
  const windows: QuotaWindowState[] = []
  const limiterWindows: RateLimitWindow[] = []
  let limited = false
  let resetsAt: Date | undefined

  for (const bucket of state.buckets.values()) {
    const reading = {
      utilizationSource: bucket.utilization === undefined ? ("none" as const) : bucket.source,
      resetSource: resetSourceOf(bucket),
      ...(bucket.utilization === undefined ? {} : { utilization: bucket.utilization }),
      ...(bucket.resetsAt === undefined ? {} : { resetsAt: bucket.resetsAt }),
    }

    if (bucket.kind !== null) {
      windows.push({ window: bucket.kind, lastCheckedAt: bucket.lastCheckedAt, ...reading })
    }
    limiterWindows.push({ limiter: bucket.limiter, ...reading })

    // A model family's own window refuses that family and nothing else, so it is never the Account's
    // verdict: the window above carries it, and routing filters by the model asked for.
    if (!isLimited(bucket, now) || mode === "reading" || MODEL_SCOPED_WINDOWS.has(bucket.limiter))
      continue
    limited = true
    if (bucket.resetsAt !== undefined && (resetsAt === undefined || bucket.resetsAt > resetsAt)) {
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

/**
 * The upstream just served this Account, so a refusal that named no window is over, and so is one
 * that named no reset. Without this both outlived their cause: nothing else ever wrote the unnamed
 * bucket again, and every later success re-reported the refusal and re-cooled the Account.
 * A refusal with a window *and* a future reset keeps its own clock.
 */
export function clearStaleRefusals(state: AccountQuota, key: string, now: Date): void {
  if (key !== SDK_DEFAULT_BUCKET) state.buckets.delete(SDK_DEFAULT_BUCKET)
  for (const [name, bucket] of state.buckets) {
    if (isLimited(bucket, now) && bucket.resetsAt === undefined && !MODEL_SCOPED_WINDOWS.has(name))
      state.buckets.set(name, { ...bucket, limited: false })
  }
}

export function futureReset(bucket: QuotaBucket | undefined, now: Date): Date | undefined {
  return bucket?.resetsAt !== undefined && bucket.resetsAt > now ? bucket.resetsAt : undefined
}

export function isLimited(bucket: QuotaBucket, now: Date): boolean {
  return bucket.limited && (bucket.resetsAt === undefined || bucket.resetsAt > now)
}

function resetSourceOf(bucket: QuotaBucket): ResetSource {
  return bucket.resetsAt === undefined ? "unknown" : "provider-reported"
}

/** Zod validated the shape, not the vocabulary; an unknown kind is a bucket, never a window. */
export function windowKind(raw: string | null): QuotaWindowKind | null {
  if (raw === null) return null
  const parsed = QuotaWindowKindSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
