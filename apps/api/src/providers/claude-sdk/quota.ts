import type {
  QuotaWindowKind,
  QuotaWindowState,
  ResetSource,
  UtilizationSource,
} from "@multi-ai-router/core"
import { QuotaWindowKind as QuotaWindowKindSchema } from "@multi-ai-router/core"
import type { RateLimitSignal, RateLimitWindow } from "../types"
import {
  clampFraction,
  readSdkRateLimitInfo,
  type SdkRateLimitReading,
  type SdkUsageGaugeReading,
} from "./quota-reading"

/**
 * SDK readings in, Account quota state out (docs/idea/11-anthropic-agent-sdk.md §5).
 *
 * The SDK reports its limits inside the query stream rather than in a response header, which is why
 * this exists at all: an HTTP account's headroom is parsed off the response it just answered
 * (`rate-limit/parse.ts`), and a subscription's rides a message the client must never see. Same
 * destination, two sources — a `RateLimitSignal` the health store folds in exactly as it folds in an
 * HTTP one, so `cooling_down`, `Retry-After`, and the breaker are written once for both transports.
 *
 * Two readings feed one set of per-window buckets, and the bucket remembers which fed it:
 *
 * - **`rate_limit_event` — an alarm, not a gauge.** The SDK populates `utilization` only near the
 *   limit, so it reads absent for most of every window. That is a normal reading and it is labelled
 *   as one: `utilizationSource: "threshold-triggered"` whenever the event carried a value, which is
 *   precisely what stops `quota-aware` from ranking accounts on an absence
 *   (`services/routing/quota.ts`). The event is also the only reading that can say **rejected** —
 *   it is the account refusing a request — so it alone may mark a bucket `limited`.
 * - **The usage gauge — continuous.** The plan-usage percentages behind the CLI's `/usage`, asked
 *   for through the SDK's own query object once a turn (`usage-gauge.ts`). Every window it names
 *   carries a number, labelled `continuous`, which is the second source §5 always described. It is
 *   a reading of how full a window is, never a verdict: a gauge at 100% leaves the breaker alone and
 *   lets `quota-window-spent` — the filter that already reads utilization — do the excluding.
 * - **The two merge per window, and neither erases the other's fact.** An alarm that carried no
 *   utilization leaves a gauge's percentage standing (it said nothing about fullness); an alarm that
 *   did carry one wins, because it is the fresher and the nearer-the-limit reading; a gauge never
 *   clears an alarm's `limited` — only the next event or the window's reset does.
 * - **An event that named no window still counts.** A `rejected` with no `rateLimitType` is the
 *   account saying "not now", so it lands in an internal `default` bucket and cools the account
 *   down — but it is never rendered as a real window, because naming which window was spent would
 *   be inventing the one fact the event withheld. A window kind this build does not know lands in
 *   its own unrendered bucket for the same reason, under the SDK's own word for it.
 * - **Never a process singleton.** State is per-runtime and keyed by Account, exactly like the
 *   health store: a module-level map would bleed one runtime's readings into another's inside a
 *   single process, and every test would start dirty.
 */

/** The bucket an event that named no window lands in. Never rendered as a `QuotaWindowState`. */
export const SDK_DEFAULT_BUCKET = "default"

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
  /**
   * Folds one usage-gauge reading into this Account's state. The returned signal is never
   * `limited` — see the module comment — so applying it to the health store records the windows and
   * touches nothing else.
   */
  ingestGauge(accountId: string, reading: SdkUsageGaugeReading, now: Date): SdkQuotaSnapshot
  /** The Account's current reading, or null when it has never reported one. */
  snapshot(accountId: string): SdkQuotaSnapshot | null
  /** Drops every reading for an Account — deletion, and the operator's "Re-check now". */
  forget(accountId: string): void
}

export function createSdkQuotaStore(): SdkQuotaStore {
  const accounts = new Map<string, AccountQuota>()

  const stateOf = (accountId: string): AccountQuota => {
    const existing = accounts.get(accountId)
    if (existing !== undefined) return existing
    const fresh: AccountQuota = { buckets: new Map(), usingOverage: false }
    accounts.set(accountId, fresh)
    return fresh
  }

  return {
    ingest(accountId, info, now) {
      const reading = readSdkRateLimitInfo(info, now)
      if (reading === null) return null

      const state = stateOf(accountId)
      const key = reading.rateLimitType ?? SDK_DEFAULT_BUCKET
      const previous = state.buckets.get(key)
      const alarmed = reading.utilization !== null
      state.buckets.set(key, {
        limiter: key,
        kind: windowKind(reading.rateLimitType),
        limited: reading.status === "rejected",
        // An alarm that said nothing about fullness leaves the gauge's number standing.
        utilization: alarmed
          ? clampFraction(reading.utilization ?? 0)
          : previous?.source === "continuous"
            ? previous.utilization
            : undefined,
        source: alarmed ? "threshold-triggered" : (previous?.source ?? "none"),
        resetsAt: reading.resetsAt ?? previous?.resetsAt,
        lastCheckedAt: now,
      })
      state.usingOverage = reading.usingOverage
      applyOverage(state, reading, key, now)

      return snapshotOf(state, "verdict")
    },

    ingestGauge(accountId, reading, now) {
      const state = stateOf(accountId)
      for (const window of reading.windows) {
        const previous = state.buckets.get(window.kind)
        state.buckets.set(window.kind, {
          limiter: window.kind,
          kind: window.kind,
          // Only an event may say rejected; a gauge never lifts or sets that verdict.
          limited: previous?.limited ?? false,
          utilization: window.utilization ?? undefined,
          source: window.utilization === null ? (previous?.source ?? "none") : "continuous",
          resetsAt: window.resetsAt ?? previous?.resetsAt,
          lastCheckedAt: now,
        })
      }
      return snapshotOf(state, "reading")
    },

    snapshot(accountId) {
      const state = accounts.get(accountId)
      return state === undefined ? null : snapshotOf(state, "verdict")
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
  /** Which reading `utilization` came from. `none` whenever it is undefined. */
  readonly source: UtilizationSource
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
function snapshotOf(state: AccountQuota, mode: "verdict" | "reading"): SdkQuotaSnapshot {
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

    if (!bucket.limited || mode === "reading") continue
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

function resetSourceOf(bucket: QuotaBucket): ResetSource {
  return bucket.resetsAt === undefined ? "unknown" : "provider-reported"
}

/** Zod validated the shape, not the vocabulary; an unknown kind is a bucket, never a window. */
function windowKind(raw: string | null): QuotaWindowKind | null {
  if (raw === null) return null
  const parsed = QuotaWindowKindSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

// The readers live in `quota-reading.ts`; re-exported so every existing import keeps working.
export {
  readSdkRateLimitInfo,
  readSdkUsageGauge,
  SDK_EPOCH_MILLIS_FLOOR,
  type SdkGaugeWindow,
  type SdkRateLimitReading,
  type SdkRateLimitStatus,
  type SdkUsageGaugeReading,
} from "./quota-reading"
