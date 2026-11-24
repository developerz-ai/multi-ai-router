import type { QuotaWindowState } from "@multi-ai-router/core"
import type { RateLimitSignal } from "../types"
import {
  type AccountQuota,
  applyOverage,
  clearStaleRefusals,
  futureReset,
  isLimited,
  SDK_DEFAULT_BUCKET,
  snapshotOf,
  windowKind,
} from "./quota-buckets"
import {
  clampFraction,
  MODEL_SCOPED_WINDOWS,
  readSdkRateLimitInfo,
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
 *   down until its reset or the next request the upstream serves — but it is never rendered as a real window, because naming which window was spent would
 *   be inventing the one fact the event withheld. A window kind this build does not know lands in
 *   its own unrendered bucket for the same reason, under the SDK's own word for it.
 * - **Never a process singleton.** State is per-runtime and keyed by Account, exactly like the
 *   health store: a module-level map would bleed one runtime's readings into another's inside a
 *   single process, and every test would start dirty.
 */

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
  snapshot(accountId: string, now: Date): SdkQuotaSnapshot | null
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
      const reported = reading.utilization !== null
      const rejected = reading.status === "rejected"
      const modelSpent = rejected && reading.resetsAt !== null && MODEL_SCOPED_WINDOWS.has(key)
      if (reading.requestStatus === "allowed" || reading.requestStatus === "allowed_warning")
        clearStaleRefusals(state, key, now)
      // A continuous reporter (the fast transport's headers) is a gauge, not an alarm.
      const fresh = reading.continuous ? "continuous" : "threshold-triggered"
      state.buckets.set(key, {
        limiter: key,
        kind: windowKind(reading.rateLimitType),
        limited: rejected,
        // A reading that said nothing about fullness leaves the gauge's number standing — except a
        // refusal by a model's own window, which is that window saying it is full. It is the fact
        // the per-model filter reads, since such a refusal never cools the Account. Only beside a
        // reset: a spent window with no clock would hold the model with nothing to let it out.
        utilization: reported
          ? clampFraction(reading.utilization ?? 0)
          : modelSpent
            ? 1
            : previous?.source === "continuous"
              ? previous.utilization
              : undefined,
        source: reported || modelSpent ? fresh : (previous?.source ?? "none"),
        resetsAt: reading.resetsAt ?? futureReset(previous, now),
        lastCheckedAt: now,
      })
      state.usingOverage = reading.usingOverage
      applyOverage(state, reading, key, now)

      return snapshotOf(state, "verdict", now)
    },

    ingestGauge(accountId, reading, now) {
      const state = stateOf(accountId)
      for (const window of reading.windows) {
        const previous = state.buckets.get(window.kind)
        state.buckets.set(window.kind, {
          limiter: window.kind,
          kind: window.kind,
          // Only an event may say rejected; a gauge never lifts or sets that verdict.
          limited: previous !== undefined && isLimited(previous, now),
          utilization: window.utilization ?? undefined,
          source: window.utilization === null ? (previous?.source ?? "none") : "continuous",
          resetsAt: window.resetsAt ?? futureReset(previous, now),
          lastCheckedAt: now,
        })
      }
      return snapshotOf(state, "reading", now)
    },

    snapshot(accountId, now) {
      const state = accounts.get(accountId)
      return state === undefined ? null : snapshotOf(state, "verdict", now)
    },

    forget(accountId) {
      accounts.delete(accountId)
    },
  }
}

export { SDK_DEFAULT_BUCKET } from "./quota-buckets"
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
