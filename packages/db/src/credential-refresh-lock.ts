import { advisoryLockKey } from "./advisory-lock"
import {
  createSessionAdvisoryLockPool,
  type SessionAdvisoryLockPoolHandle,
  type SessionAdvisoryLockPoolOptions,
} from "./session-advisory-lock"
export type CredentialRefreshLockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false; reason: "busy" | "aborted" }
export interface CredentialRefreshLock {
  tryRun<T>(
    accountId: string,
    signal: AbortSignal,
    work: (lockSignal: AbortSignal) => Promise<T>,
  ): Promise<CredentialRefreshLockResult<T>>
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
    close: pool.close,
    poolStats: pool.poolStats,
  }
}
