import type { ClaudeLoginHandle } from "../../../providers/claude-sdk/login"

/** Local cancellation complements durable filesystem ownership; it never authorizes cleanup. */
export function createClaudeLoginLifetime(timeoutMs: number, warn: (owners: number) => void) {
  const controllers = new Map<string, Set<AbortController>>()
  const handles = new Map<string, Set<ClaudeLoginHandle>>()
  const flights = new Set<Promise<unknown>>()
  const revoked = new Set<string>()
  let closed = false
  let deadlineExpired = false
  let stopping: Promise<void> | undefined
  const reportUnknown = (owners: number) => {
    try {
      warn(owners)
    } catch {
      /* Reporting must not prevent cancellation or exit observation. */
    }
  }
  const cancel = (id: string) => {
    for (const controller of controllers.get(id) ?? []) controller.abort()
    for (const handle of handles.get(id) ?? []) handle.cancel()
  }
  return {
    isClosed: (id: string) => closed || revoked.has(id),
    canCommit: (id: string) => !deadlineExpired && !revoked.has(id),
    revoke: (id: string) => {
      revoked.add(id)
      cancel(id)
    },
    closeAdmission: () => {
      closed = true
      for (const id of new Set([...controllers.keys(), ...handles.keys()])) cancel(id)
    },
    run: <T>(id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const controller = new AbortController()
      const own = controllers.get(id) ?? new Set<AbortController>()
      own.add(controller)
      controllers.set(id, own)
      if (closed || revoked.has(id)) controller.abort()
      const flight = work(controller.signal).finally(() => {
        own.delete(controller)
        if (own.size === 0) controllers.delete(id)
        flights.delete(flight)
      })
      flights.add(flight)
      return flight
    },
    observe: (id: string, handle: ClaudeLoginHandle) => {
      const own = handles.get(id) ?? new Set<ClaudeLoginHandle>()
      own.add(handle)
      handles.set(id, own)
      // Rejection means unknown exit; filesystem owner markers remain the cleanup authority.
      void handle.exited
        .catch(() => reportUnknown(1))
        .finally(() => {
          own.delete(handle)
          if (own.size === 0) handles.delete(id)
        })
      if (closed || revoked.has(id)) handle.cancel()
    },
    stop: (): Promise<void> => {
      if (stopping !== undefined) return stopping
      closed = true
      for (const id of new Set([...controllers.keys(), ...handles.keys()])) cancel(id)
      let timer: ReturnType<typeof setTimeout> | undefined
      const waiting = (async () => {
        // Starts admitted before stop may reveal their handle only after their URL wait ends.
        await Promise.allSettled([...flights])
        await Promise.allSettled(
          [...handles.values()].flatMap((owners) => [...owners].map((handle) => handle.exited)),
        )
      })()
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          deadlineExpired = true
          try {
            warn(flights.size + [...handles.values()].reduce((n, owners) => n + owners.size, 0))
          } catch {
            /* Reporting cannot trap shutdown. */
          } finally {
            resolve()
          }
        }, timeoutMs)
      })
      stopping = Promise.race([waiting, deadline]).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
      })
      return stopping
    },
  }
}
