import { createSessionAdvisoryLockPool } from "./session-advisory-lock"
import type {
  SessionAdvisoryLockPoolHandle,
  SessionAdvisoryLockPoolOptions,
} from "./session-advisory-lock-types"

export type {
  SessionAdvisoryLease as SdkSessionClaimLease,
  SessionAdvisoryLockPoolHandle as SdkSessionClaimLockPoolHandle,
  SessionAdvisoryLockPoolOptions,
} from "./session-advisory-lock-types"

/**
 * Dedicated class for SDK session claims. Distinct from the scheduler and credential-refresh
 * classes so a turn's held lease cannot collide with maintenance locks, and pinned so keys stay
 * stable across rolling deploys. The key derivation is `advisoryLockKey` (already exported), which
 * the SDK session-claim caller uses for both the conversation and account-scoped SDK keys.
 */
export const SDK_SESSION_CLAIM_LOCK_CLASS = 0x7364_6b73
export function createSdkSessionClaimLockPool(
  options: Omit<SessionAdvisoryLockPoolOptions, "lockClass">,
): SessionAdvisoryLockPoolHandle {
  // A resume holds the conversation and account-scoped SDK leases simultaneously.
  return createSessionAdvisoryLockPool({
    ...options,
    maxConnections: Math.max(2, options.maxConnections ?? 2),
    lockClass: SDK_SESSION_CLAIM_LOCK_CLASS,
  })
}
