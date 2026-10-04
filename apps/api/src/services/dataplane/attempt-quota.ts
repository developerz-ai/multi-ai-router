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
  const accepts = () =>
    active &&
    started() &&
    !signal.aborted &&
    runtime.health.acceptsObservation(accountId, observation)
  return {
    accepts,
    observe(reading: RateLimitSignal, at: Date) {
      if (!accepts()) return
      limited ||= reading.limited
      runtime.health.applyRateLimit(accountId, reading, at, observation)
    },
    limited: () => limited,
    close: () => {
      active = false
    },
  }
}
