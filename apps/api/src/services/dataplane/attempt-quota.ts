import type { RateLimitSignal } from "../../providers"
import type { HealthObservation } from "./health-observation"
import type { DispatchRuntime } from "./runtime"

/** Late SDK evidence belongs to its original live attempt, including its generation. */
export function attemptQuota(
  runtime: DispatchRuntime,
  accountId: string,
  observation: HealthObservation,
  started: () => boolean,
  signal: AbortSignal,
) {
  let active = true
  let limited = false
  /**
   * A probing turn publishes its success at its first output (`relay-health.ts`), and the row coming
   * back from Postgres moves the generation this attempt was observed in. What it reads after that is
   * still about the same account; `followAttempt` refuses once a lifecycle or credential changed.
   */
  const current = () => runtime.health.followAttempt?.(accountId, observation) ?? observation
  const accepts = () =>
    active &&
    started() &&
    !signal.aborted &&
    runtime.health.acceptsObservation(accountId, current())
  return {
    accepts,
    observe(reading: RateLimitSignal, at: Date) {
      if (!accepts()) return
      limited ||= reading.limited
      runtime.health.applyRateLimit(accountId, reading, at, current())
    },
    limited: () => limited,
    close: () => {
      active = false
    },
  }
}
