import postgres from "postgres"
import { DATABASE_POOL_DEFAULTS } from "./client"
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
interface Generation {
  sql: ReturnType<typeof postgres>
  occupied: number
  holders: Set<AbortController>
  retired: boolean
  disposal?: Promise<void>
}

export function createSessionAdvisoryLockPool(
  options: SessionAdvisoryLockPoolOptions,
): SessionAdvisoryLockPoolHandle {
  const max = options.maxConnections ?? 1
  const connectTimeout =
    options.connectTimeoutSeconds ?? DATABASE_POOL_DEFAULTS.connectTimeoutSeconds
  const closeTimeout = options.closeTimeoutSeconds ?? DATABASE_POOL_DEFAULTS.closeTimeoutSeconds
  if (
    !options.url ||
    !Number.isInteger(options.lockClass) ||
    options.lockClass < -2147483648 ||
    options.lockClass > 2147483647 ||
    !Number.isInteger(max) ||
    max < 1 ||
    !Number.isFinite(connectTimeout) ||
    !Number.isFinite(closeTimeout) ||
    connectTimeout <= 0 ||
    closeTimeout < 0
  ) {
    throw new Error("createSessionAdvisoryLockPool: invalid options")
  }
  let stopping = false
  let current: Generation | undefined
  const keys = new Set<number>()
  const active = new Set<Promise<unknown>>()
  let closing: Promise<void> | undefined

  function retire(generation: Generation): Promise<void> {
    if (generation.disposal !== undefined) return generation.disposal
    generation.retired = true
    // Assign before end invokes further onclose callbacks.
    generation.disposal = Promise.resolve()
      .then(() => generation.sql.end({ timeout: 0 }))
      .then(() => {
        if (current === generation && generation.occupied === 0 && !stopping) current = undefined
      })
    for (const holder of generation.holders)
      holder.abort(new Error("session advisory lock session lost"))
    return generation.disposal
  }
  function generation(): Generation {
    if (current !== undefined) return current
    const raw = postgres(options.url, {
      max,
      connect_timeout: connectTimeout,
      idle_timeout: 0,
      max_lifetime: 0,
      onnotice() {},
      onclose() {
        void retire(created).catch(() => undefined)
      },
    })
    const created: Generation = { sql: raw, occupied: 0, holders: new Set(), retired: false }
    current = created
    return created
  }

  async function query<T>(
    owner: Generation,
    pending: PromiseLike<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectStopped: (error: Error) => void = () => undefined
    const stopped = new Promise<never>((_, reject) => {
      rejectStopped = reject
    })
    const stop = () => {
      void retire(owner).catch(() => undefined)
      rejectStopped(new Error("session advisory query interrupted"))
    }
    const result = Promise.resolve(pending)
    // Pool disposal prevents a late successful acquisition from retaining an unobserved lock.
    void result.catch(() => undefined)
    signal?.addEventListener("abort", stop, { once: true })
    timer = setTimeout(stop, connectTimeout * 1000)
    if (signal?.aborted || owner.retired) stop()
    try {
      return await Promise.race([result, stopped])
    } catch (error) {
      await retire(owner)
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", stop)
    }
  }

  /** Everything tryRun and tryAcquire share, from admission to a held, session-locked key. */
  interface HeldLock {
    readonly acquired: true
    readonly key: number
    readonly owner: Generation
    readonly controller: AbortController
    readonly reserved: postgres.ReservedSql
    readonly finish: () => void
  }

  /** The cleanup tryRun's finally performs: unlock, hand the connection back, un-bookkeep. */
  async function releaseHeld(
    held: Pick<HeldLock, "key" | "owner" | "reserved" | "finish">,
    acquired: boolean,
  ): Promise<void> {
    try {
      if (acquired && !held.owner.retired) {
        const rows = await query(
          held.owner,
          held.reserved<
            { unlocked: boolean }[]
          >`select pg_advisory_unlock(${options.lockClass}, ${held.key}) as unlocked`,
        )
        if (rows[0]?.unlocked !== true) await retire(held.owner)
      }
    } catch {
      await retire(held.owner)
    } finally {
      held.reserved.release()
      held.finish()
    }
  }

  async function acquire(
    key: number,
    signal: AbortSignal,
  ): Promise<HeldLock | { acquired: false; reason: "busy" | "capacity" | "aborted" }> {
    if (stopping || signal.aborted) return { acquired: false, reason: "aborted" }
    if (current?.retired) return { acquired: false, reason: "capacity" }
    const owner = generation()
    if (keys.has(key)) return { acquired: false, reason: "busy" }
    if (owner.occupied >= max) return { acquired: false, reason: "capacity" }
    owner.occupied++
    keys.add(key)
    const controller = new AbortController()
    owner.holders.add(controller)
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    let released = false
    const finish = () => {
      if (released) return
      released = true
      owner.occupied--
      owner.holders.delete(controller)
      keys.delete(key)
      signal.removeEventListener("abort", abort)
      if (owner.retired && owner.disposal !== undefined) {
        void owner.disposal.then(
          () => {
            if (current === owner && owner.occupied === 0 && !stopping) current = undefined
          },
          () => undefined,
        )
      }
    }
    let reserved: postgres.ReservedSql | undefined
    let acquired = false
    let lateCleanup = false
    let keep = false
    const timeout = setTimeout(
      () => controller.abort(new Error("session advisory reservation deadline")),
      connectTimeout * 1000,
    )
    const cancellation = new Promise<undefined>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(undefined), { once: true })
    })
    try {
      const pending = owner.sql.reserve()
      const guarded = pending.then(
        (connection) => {
          if (controller.signal.aborted || owner.retired || stopping) {
            connection.release()
            finish()
            return undefined
          }
          return connection
        },
        (error) => {
          finish()
          throw error
        },
      )
      reserved = await Promise.race([guarded, cancellation])
      if (reserved === undefined) {
        lateCleanup = true
        void guarded.then(
          (connection) => {
            if (connection !== undefined) {
              connection.release()
              finish()
            }
          },
          () => undefined,
        )
        return { acquired: false, reason: "aborted" }
      }
      clearTimeout(timeout)
      if (controller.signal.aborted || owner.retired || stopping)
        return { acquired: false, reason: "aborted" }
      const rows = await query(
        owner,
        reserved<
          { locked: boolean }[]
        >`select pg_try_advisory_lock(${options.lockClass}, ${key}) as locked`,
        controller.signal,
      )
      acquired = rows[0]?.locked === true
      if (!acquired) return { acquired: false, reason: "busy" }
      if (controller.signal.aborted || owner.retired || stopping)
        return { acquired: false, reason: "aborted" }
      // Past this line the caller owns the cleanup; the finally below must not run it too.
      keep = true
      return { acquired: true, key, owner, controller, reserved, finish }
    } catch (error) {
      if (!acquired && controller.signal.aborted) return { acquired: false, reason: "aborted" }
      throw error
    } finally {
      clearTimeout(timeout)
      if (!keep) {
        if (reserved !== undefined) await releaseHeld({ key, owner, reserved, finish }, acquired)
        else if (!lateCleanup) finish()
      }
    }
  }

  async function run<T>(
    key: number,
    signal: AbortSignal,
    work: (lockSignal: AbortSignal) => Promise<T>,
  ): Promise<SessionAdvisoryLockResult<T>> {
    const held = await acquire(key, signal)
    if (!held.acquired) return held
    try {
      if (held.controller.signal.aborted || held.owner.retired || stopping)
        return { acquired: false, reason: "aborted" }
      return { acquired: true, value: await work(held.controller.signal) }
    } finally {
      await releaseHeld(held, true)
    }
  }

  async function acquireLease(
    key: number,
    signal: AbortSignal,
  ): Promise<SessionAdvisoryLockResult<SessionAdvisoryLease>> {
    const held = await acquire(key, signal)
    if (!held.acquired) return held
    const { controller } = held
    let released = false
    let resolveFinished: () => void = () => undefined
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve
    })
    // Tracked beside run() operations, so close() waits for a lease's release the same way.
    active.add(finished)
    let release: () => Promise<void>
    const onAbort = (): void => {
      void release().catch(() => undefined)
    }
    release = async (): Promise<void> => {
      if (released) return
      released = true
      controller.signal.removeEventListener("abort", onAbort)
      try {
        await releaseHeld(held, true)
      } finally {
        resolveFinished()
        active.delete(finished)
      }
    }
    // acquire() checked the holder signal before handing over; cover the gap since.
    controller.signal.addEventListener("abort", onAbort, { once: true })
    if (controller.signal.aborted) void onAbort()
    return { acquired: true, value: { release } }
  }
  return {
    tryRun: (id, signal, work) => {
      const operation = run(id, signal, work)
      active.add(operation)
      void operation.then(
        () => active.delete(operation),
        () => active.delete(operation),
      )
      return operation
    },
    tryAcquire: (id, signal) => {
      const operation = acquireLease(id, signal)
      active.add(operation)
      void operation.then(
        () => active.delete(operation),
        () => active.delete(operation),
      )
      return operation
    },
    poolStats: () => ({
      inUse: current?.occupied ?? 0,
      idle: Math.max(0, max - (current?.occupied ?? 0)),
      waiting: 0,
      max,
    }),
    close: () => {
      if (closing !== undefined) return closing
      stopping = true
      for (const holder of current?.holders ?? [])
        holder.abort(new Error("session advisory pool shutting down"))
      closing = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            Promise.allSettled([...active]),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, closeTimeout * 1000)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
        if (current !== undefined) await retire(current)
      })()
      return closing
    },
  }
}
