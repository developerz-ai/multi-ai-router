import postgres from "postgres"
import { DATABASE_POOL_DEFAULTS } from "./client"
import type { PoolSample } from "./pool-metrics"

export type SessionAdvisoryLockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false; reason: "busy" | "aborted" }
export interface SessionAdvisoryLock {
  tryRun<T>(
    key: number,
    signal: AbortSignal,
    work: (lockSignal: AbortSignal) => Promise<T>,
  ): Promise<SessionAdvisoryLockResult<T>>
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

  async function run<T>(
    key: number,
    signal: AbortSignal,
    work: (lockSignal: AbortSignal) => Promise<T>,
  ): Promise<SessionAdvisoryLockResult<T>> {
    if (stopping || signal.aborted) return { acquired: false, reason: "aborted" }
    if (current?.retired) return { acquired: false, reason: "busy" }
    const owner = generation()
    if (owner.occupied >= max || keys.has(key)) return { acquired: false, reason: "busy" }
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
      return { acquired: true, value: await work(controller.signal) }
    } catch (error) {
      if (!acquired && controller.signal.aborted) return { acquired: false, reason: "aborted" }
      throw error
    } finally {
      clearTimeout(timeout)
      if (reserved !== undefined) {
        try {
          if (acquired && !owner.retired) {
            const rows = await query(
              owner,
              reserved<
                { unlocked: boolean }[]
              >`select pg_advisory_unlock(${options.lockClass}, ${key}) as unlocked`,
            )
            if (rows[0]?.unlocked !== true) await retire(owner)
          }
        } catch {
          await retire(owner)
        } finally {
          reserved.release()
          finish()
        }
      } else if (!lateCleanup) finish()
    }
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
