import type { SessionAdvisoryLease } from "./session-advisory-lock-types"

/**
 * Wraps a held session lock as a caller-owned lease: `release` runs the pool's cleanup exactly
 * once, the holder signal aborting releases it too, and the release is tracked in `active` beside
 * running operations so the pool's `close()` waits for it the same way.
 */
export function leaseOnce(
  holder: AbortSignal,
  cleanup: () => Promise<void>,
  active: Set<Promise<unknown>>,
): SessionAdvisoryLease {
  let released = false
  let resolveFinished: () => void = () => undefined
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve
  })
  active.add(finished)
  let release: () => Promise<void>
  const onAbort = (): void => {
    void release().catch(() => undefined)
  }
  release = async (): Promise<void> => {
    if (released) return
    released = true
    holder.removeEventListener("abort", onAbort)
    try {
      await cleanup()
    } finally {
      resolveFinished()
      active.delete(finished)
    }
  }
  // The pool checked the holder signal before handing over; cover the gap since.
  holder.addEventListener("abort", onAbort, { once: true })
  if (holder.aborted) onAbort()
  return { release }
}
