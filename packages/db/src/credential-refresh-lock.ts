import { advisoryLockKey } from "./advisory-lock"
import {
  createSessionAdvisoryLockPool,
  type SessionAdvisoryLockPoolHandle,
  type SessionAdvisoryLockPoolOptions,
} from "./session-advisory-lock"
export type CredentialRefreshLockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false; reason: "busy" | "aborted" }
/** One held cross-replica refresh mutex; `release` is idempotent. */
export interface CredentialRefreshLease {
  release(): Promise<void>
}
export type CredentialRefreshLeaseResult =
  | { acquired: true; lease: CredentialRefreshLease }
  | { acquired: false; reason: "busy" | "capacity" | "aborted" }
export interface CredentialRefreshLock {
  tryRun<T>(
    accountId: string,
    signal: AbortSignal,
    work: (lockSignal: AbortSignal) => Promise<T>,
  ): Promise<CredentialRefreshLockResult<T>>
  /**
   * Takes the per-account mutex without running work. Held from acquisition until
   * `lease.release()` — not until some work function settles — and self-released on abort, pool
   * stop, or connection loss, so a crashed holder cannot wedge the account.
   */
  tryAcquire(accountId: string, signal: AbortSignal): Promise<CredentialRefreshLeaseResult>
}
export type CredentialRefreshLockPoolOptions = Omit<SessionAdvisoryLockPoolOptions, "lockClass">
export interface CredentialRefreshLockPoolHandle extends CredentialRefreshLock {
  close(): Promise<void>
  poolStats(): ReturnType<SessionAdvisoryLockPoolHandle["poolStats"]>
}
/** Refresh namespace remains distinct from tasks and migrations across rolling deploys. */
export function createCredentialRefreshLockPool(
  options: CredentialRefreshLockPoolOptions,
): CredentialRefreshLockPoolHandle {
  const pool = createSessionAdvisoryLockPool({ ...options, lockClass: 0x7265_6672 })
  return {
    tryRun: async (id, signal, work) => {
      const result = await pool.tryRun(advisoryLockKey(id), signal, work)
      return result.acquired
        ? result
        : {
            acquired: false,
            reason: result.reason === "aborted" ? "aborted" : "busy",
          }
    },
    // Same namespace and key mapping as tryRun: one mutex per account, held from acquisition
    // until lease.release().
    tryAcquire: async (id, signal) => {
      const result = await pool.tryAcquire(advisoryLockKey(id), signal)
      return result.acquired
        ? { acquired: true, lease: result.value }
        : { acquired: false, reason: result.reason }
    },
    close: pool.close,
    poolStats: pool.poolStats,
  }
}
