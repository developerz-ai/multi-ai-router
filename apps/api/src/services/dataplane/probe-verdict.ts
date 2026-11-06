import { describeProvider } from "../accounts/providers"
import type { FailureKind } from "../routing"
import { breakerOptionsFor, type HealthStore } from "./health"
import type { HealthObservation } from "./health-observation"
import type { RoutableAccount } from "./types"

/**
 * What a failed router-sent probe does to the account, whichever probe sent it. One path, so a
 * drained balance becomes `exhausted` and a rejected token parks through `onBlocked` the same way
 * from a recovery probe, an hourly recheck, or a client's request.
 */
export function strikeProbeFailure(
  health: Pick<HealthStore, "recordFailure">,
  account: RoutableAccount,
  failure: { readonly kind: FailureKind; readonly message: string },
  now: Date,
  observation: HealthObservation,
): void {
  const authKind = describeProvider(account.driver.provider).authKind
  health.recordFailure(
    account.id,
    failure,
    now,
    { ...(authKind === null ? {} : breakerOptionsFor(authKind)), recoveryProbe: true },
    observation,
  )
}
