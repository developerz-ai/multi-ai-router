import type { QuotaWindowKind, QuotaWindowState } from "@multi-ai-router/core"
import type { DriverAccount, RateLimitSignal } from "./types"

/**
 * A provider that answers "how much of the plan is spent" on its own endpoint, rather than on the
 * responses the router is already making, declares how to ask and how to read the answer here — on
 * the driver, so the service that does the fetch never names a provider (non-negotiable 12). Every
 * member is pure; the fetch, the timer and the lock live in `services/models/plan-quota.ts` and
 * `scheduler/tasks/plan-quota-read.ts`.
 */
export interface ProviderQuotaRead {
  /**
   * The usage endpoint. `null` for an Account whose credential must not be sent there: the endpoint
   * is pinned, so an Account the operator pointed elsewhere holds a key this provider may never
   * have issued.
   */
  url(account: DriverAccount): URL | null
  /** Statuses meaning "this credential holds no plan to read": a skip, not a failure. */
  readonly noPlanStatuses: ReadonlySet<number>
  /**
   * Whether a 2xx body is a well-formed answer that states **no plan window at all** — a key without
   * the plan this endpoint describes. A skip, not a failure: logging it as `quota:unreadable` every
   * tick made the sweep report `partial` forever and hid every real failure behind it (tesote, 384
   * of 415 runs since 2026-11-07; sweep 101, 12.10). Asked only when {@link read} returned `null`.
   * Absent: every unreadable body is a failure.
   */
  noPlan?(body: unknown): boolean
  /**
   * Zod at the boundary: `null` for a shape this build cannot read, never a partial reading.
   *
   * A signal because that is the only way a reading reaches an Account (`RateLimitSignal.quotaWindows`).
   * `limited` must stay false: a background read is not a verdict, and a `true` here would cool the
   * Account on the router's own say-so. `at` is when the reading was taken — this member has no clock.
   */
  read(body: unknown, at: Date): RateLimitSignal | null
}

/**
 * One named window as every plan reader reports it: a continuous reading, advisory, its reset the
 * provider's own or unknown. Advisory because a background read is not a verdict — the upstream's
 * own `429` is what takes an Account out of rotation; this reading only says how long that lasts
 * (`routing/quota.ts`, `spentPlanReset`) and ranks headroom for `quota-aware`.
 */
export function advisoryWindow(
  window: QuotaWindowKind,
  utilization: number,
  resetsAt: Date | undefined,
  at: Date,
): QuotaWindowState {
  return {
    window,
    utilization: Math.min(Math.max(utilization, 0), 1),
    utilizationSource: "continuous",
    ...(resetsAt === undefined
      ? { resetSource: "unknown" as const }
      : { resetsAt, resetSource: "provider-reported" as const }),
    lastCheckedAt: at,
    advisory: true,
  }
}

/** An epoch-milliseconds instant, or `undefined` for zero, negative or unrepresentable. */
export function epochMillis(value: number | undefined): Date | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}
