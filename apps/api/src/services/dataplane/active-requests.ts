/** Fixed vocabulary: no request, provider, or credential data in the abort reason. */
export class RouterShutdownError extends Error {
  constructor() {
    super("router shutting down")
    this.name = "RouterShutdownError"
  }
}
/** Closed admission and a full registry both refuse work before any paid upstream starts. */
export class RequestAdmissionUnavailableError extends Error {
  constructor() {
    super("router request admission unavailable")
    this.name = "RequestAdmissionUnavailableError"
  }
}
export interface ActiveRequestLease {
  readonly signal: AbortSignal
  /** Replace settlement as the request moves from body preparation to a real upstream attempt. */
  setAbandon(callback: () => void): void
  release(): void
}
export interface ActiveRequestRegistry {
  register(): ActiveRequestLease | undefined
  closeAdmission(): void
  stop(): Promise<void>
  readonly size: number
}
/** Bounded warm lifecycle bookkeeping; cancellation promises never delay writer shutdown. */
export function createActiveRequestRegistry(options: {
  readonly maximumEntries: number
}): ActiveRequestRegistry {
  if (!Number.isSafeInteger(options.maximumEntries) || options.maximumEntries < 1)
    throw new RangeError("active request bound must be a positive safe integer")
  const entries = new Set<{ abandon(): void; abort(): void; release(): void }>()
  let closed = false
  let stopping: Promise<void> | undefined
  return {
    register() {
      if (closed || entries.size >= options.maximumEntries) return undefined
      const controller = new AbortController()
      let callback: (() => void) | undefined
      let released = false
      const entry = {
        abandon: () => callback?.(),
        abort: () => controller.abort(new RouterShutdownError()),
        release: () => {
          if (released) return
          released = true
          callback = undefined
          entries.delete(entry)
        },
      }
      entries.add(entry)
      return {
        signal: controller.signal,
        setAbandon: (next) => {
          if (!released) callback = next
        },
        release: entry.release,
      }
    },
    closeAdmission() {
      closed = true
    },
    stop() {
      if (stopping !== undefined) return stopping
      closed = true
      const done = Promise.withResolvers<void>()
      stopping = done.promise
      const snapshot = [...entries]
      const failures: unknown[] = []
      // Settle every held event before abort listeners can reclassify it or close writers.
      for (const entry of snapshot) {
        try {
          entry.abandon()
        } catch (error) {
          failures.push(error)
        }
      }
      for (const entry of snapshot) {
        try {
          entry.abort()
        } catch (error) {
          failures.push(error)
        } finally {
          entry.release()
        }
      }
      if (failures.length > 0)
        done.reject(new AggregateError(failures, "active request shutdown callbacks failed"))
      else done.resolve()
      return stopping
    },
    get size() {
      return entries.size
    },
  }
}
