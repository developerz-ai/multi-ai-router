import { atLeastOne } from "./fields"

export const BACKGROUND_ENV_FIELDS = {
  BACKGROUND_SHUTDOWN_DRAIN_MS: atLeastOne
    .refine((value) => value <= 2_147_483_647, "must fit a timer")
    .optional(),
  SCHEDULER_LOCAL_CAPACITY_RETRY_MS: atLeastOne
    .refine((value) => value <= 60_000, "must be at most 60000")
    .optional(),
  SCHEDULER_LOCK_POOL_MAX_CONNECTIONS: atLeastOne
    .refine((value) => value <= 100, "must be at most 100")
    .optional(),
}
export function readBackgroundEnv(raw: { BACKGROUND_SHUTDOWN_DRAIN_MS?: number }) {
  return { background: { shutdownDrainMs: raw.BACKGROUND_SHUTDOWN_DRAIN_MS ?? 15_000 } }
}
