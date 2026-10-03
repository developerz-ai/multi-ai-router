import {
  createSessionAdvisoryLockPool,
  type SessionAdvisoryLockPoolHandle,
  type SessionAdvisoryLockPoolOptions,
} from "./session-advisory-lock"
export type SchedulerLockPoolOptions = Omit<SessionAdvisoryLockPoolOptions, "lockClass">
export type SchedulerLockPoolHandle = SessionAdvisoryLockPoolHandle
/** Dedicated pool. Existing rout namespace and task FNV keys must survive rolling deploys. */
export function createSchedulerLockPool(
  options: SchedulerLockPoolOptions,
): SchedulerLockPoolHandle {
  return createSessionAdvisoryLockPool({ ...options, lockClass: 0x726f_7574 })
}
