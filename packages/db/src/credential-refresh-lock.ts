import { advisoryLockKey } from "./advisory-lock"
import {
  createSessionAdvisoryLockPool,
  type SessionAdvisoryLockPoolHandle,
  type SessionAdvisoryLockPoolOptions,
  type SessionAdvisoryLockResult,
} from "./session-advisory-lock"
export type CredentialRefreshLockResult<T> = SessionAdvisoryLockResult<T>
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
    tryRun: (id, signal, work) => pool.tryRun(advisoryLockKey(id), signal, work),
    close: pool.close,
    poolStats: pool.poolStats,
  }
}
