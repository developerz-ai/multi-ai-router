import { atLeastOne } from "./fields"

const timerMs = atLeastOne.refine((value) => value <= 2_147_483_647, "must fit a timer")
const capacity = atLeastOne.refine((value) => value <= 100_000, "must be at most 100000")
export const RECOVERY_ENV_FIELDS = {
  RECOVERY_COORDINATOR_INTERVAL_MS: timerMs.optional(),
  RECOVERY_COORDINATOR_BATCH_SIZE: capacity.optional(),
  RECOVERY_DEMAND_CAPACITY: capacity.optional(),
  RECOVERY_DEMAND_TTL_MS: timerMs.optional(),
  RECOVERY_OUTCOME_CAPACITY: capacity.optional(),
  RECOVERY_PREPARATION_LEASE_MS: timerMs.optional(),
  RECOVERY_MAXIMUM_OUTCOME_MS: timerMs.optional(),
  RECOVERY_COOLDOWN_MS: timerMs.optional(),
  RECOVERY_SHUTDOWN_DRAIN_MS: timerMs.optional(),
  RECOVERY_RETRY_AFTER_MS: timerMs.optional(),
  ROUTING_QUOTA_STALE_AFTER_MS: timerMs.optional(),
}

type RecoveryEnv = { readonly [K in keyof typeof RECOVERY_ENV_FIELDS]?: number }
export function readRecoveryEnv(raw: RecoveryEnv) {
  return {
    recovery: {
      intervalMs: raw.RECOVERY_COORDINATOR_INTERVAL_MS ?? 250,
      batchSize: raw.RECOVERY_COORDINATOR_BATCH_SIZE ?? 100,
      demandCapacity: raw.RECOVERY_DEMAND_CAPACITY ?? 1_000,
      demandTtlMs: raw.RECOVERY_DEMAND_TTL_MS ?? 60_000,
      outcomeCapacity: raw.RECOVERY_OUTCOME_CAPACITY ?? 1_000,
      preparationLeaseMs: raw.RECOVERY_PREPARATION_LEASE_MS ?? 10_000,
      maximumOutcomeMs: raw.RECOVERY_MAXIMUM_OUTCOME_MS ?? 600_000,
      cooldownMs: raw.RECOVERY_COOLDOWN_MS ?? 30_000,
      shutdownDrainMs: raw.RECOVERY_SHUTDOWN_DRAIN_MS ?? 15_000,
      retryAfterMs: raw.RECOVERY_RETRY_AFTER_MS ?? 1_000,
      quotaStaleAfterMs: raw.ROUTING_QUOTA_STALE_AFTER_MS ?? 600_000,
    },
  }
}
