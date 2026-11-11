import type { PoolSample } from "./pool-metrics"

/** Capacity is local admission pressure; busy means the same key is already owned. */
export type SessionAdvisoryLockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false; reason: "busy" | "capacity" | "aborted" }
/**
 * One held advisory lock. A session lock lives on one reserved connection, so it must never
 * outlive that connection: `release` is idempotent, and the lease also releases itself when the
 * holder's signal aborts or the pool stops or loses its session.
 */
export interface SessionAdvisoryLease {
  release(): Promise<void>
}
export interface SessionAdvisoryLock {
  tryRun<T>(
    key: number,
    signal: AbortSignal,
    work: (lockSignal: AbortSignal) => Promise<T>,
  ): Promise<SessionAdvisoryLockResult<T>>
  /** Takes the lock without running work; the caller holds it until `lease.release()`. */
  tryAcquire(
    key: number,
    signal: AbortSignal,
  ): Promise<SessionAdvisoryLockResult<SessionAdvisoryLease>>
}
export interface SessionAdvisoryLockPoolOptions {
  readonly lockClass: number
  readonly url: string
  readonly maxConnections?: number
  readonly connectTimeoutSeconds?: number
  readonly closeTimeoutSeconds?: number
}
export interface SessionAdvisoryLockPoolHandle extends SessionAdvisoryLock {
  close(): Promise<void>
  poolStats(): PoolSample
}
