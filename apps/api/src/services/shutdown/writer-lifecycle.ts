/** Off-path bounded final drain. Admission closes before awaiting the current batch. */
export function createWriterLifecycle(deps: {
  flush: () => Promise<void>
  pending: () => number
  outstanding?: () => number
  timeoutMs: number
  warn: (pending: number) => void
}) {
  let deadlineExpired = false
  let accepting = true
  let draining = false
  let stopping: Promise<void> | undefined
  return {
    accepting: () => accepting,
    canWrite: () => !deadlineExpired,
    start: (): boolean => {
      if (draining) return false
      stopping = undefined
      deadlineExpired = false
      accepting = true
      return true
    },
    stop: (): Promise<void> => {
      if (stopping !== undefined) return stopping
      accepting = false
      draining = true
      let expired = false
      let reported = false
      const warn = (pending: number) => {
        if (!reported) {
          reported = true
          try {
            deps.warn(pending)
          } catch {
            // Observability failure must not prevent the deadline from releasing shutdown.
          }
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          expired = true
          deadlineExpired = true
          warn(deps.outstanding?.() ?? deps.pending())
          resolve()
        }, deps.timeoutMs)
      })
      const drain = (async () => {
        // First await joins any batch already running; a second pass owns what arrived during it.
        const flush = async () => {
          try {
            await deps.flush()
          } catch {
            // A bookkeeping/logging hook can reject even when normal repository failures are caught.
            // Keep shutdown bounded and make remaining uncertainty visible before closing resources.
            warn(deps.outstanding?.() ?? deps.pending())
          }
        }
        await flush()
        if (!expired && deps.pending() > 0) await flush()
        if (deps.pending() > 0) warn(deps.pending())
      })().finally(() => {
        draining = false
      })
      stopping = Promise.race([drain, deadline]).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
      })
      return stopping
    },
  }
}
