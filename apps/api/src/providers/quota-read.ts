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
   * Zod at the boundary: `null` for a shape this build cannot read, never a partial reading.
   *
   * A signal because that is the only way a reading reaches an Account (`RateLimitSignal.quotaWindows`).
   * `limited` must stay false: a background read is not a verdict, and a `true` here would cool the
   * Account on the router's own say-so. `at` is when the reading was taken — this member has no clock.
   */
  read(body: unknown, at: Date): RateLimitSignal | null
}
