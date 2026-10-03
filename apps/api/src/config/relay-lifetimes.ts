import { atLeastOne } from "./fields"

export const RELAY_LIFETIME_ENV_FIELDS = {
  ACTIVE_REQUEST_MAX_ENTRIES: atLeastOne
    .refine((value) => value <= 1_048_576, "must be at most 1048576")
    .optional(),
}
export function readRelayLifetimesEnv(raw: { ACTIVE_REQUEST_MAX_ENTRIES?: number }) {
  return { relayLifetimes: { maximumEntries: raw.ACTIVE_REQUEST_MAX_ENTRIES ?? 65_536 } }
}
