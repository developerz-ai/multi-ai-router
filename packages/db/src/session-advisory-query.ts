import type postgres from "postgres"

/** One lock-pool connection generation: its sessions, holders and disposal. */
export interface Generation {
  sql: ReturnType<typeof postgres>
  occupied: number
  holders: Set<AbortController>
  retired: boolean
  disposal?: Promise<void>
}

/**
 * A statement on a lock session, bounded by the connect timeout and the holder's signal. A
 * statement that is interrupted or fails retires the whole generation: a session whose lock state
 * is unknown must not be reused.
 */
export function boundedQuery(
  retire: (generation: Generation) => Promise<void>,
  connectTimeoutSeconds: number,
) {
  return async function query<T>(
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
    timer = setTimeout(stop, connectTimeoutSeconds * 1000)
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
}
