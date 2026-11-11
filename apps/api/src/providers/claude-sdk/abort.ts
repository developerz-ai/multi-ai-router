/**
 * Abort plumbing shared by the gates that queue a caller (`concurrency.ts`, the refresh window).
 * Each keeps the signal's own reason, so a deadline stays a `TimeoutError` and a disconnect an
 * `AbortError` all the way to `runSdkAttempt`'s classification; only a non-Error reason is
 * synthesised, with the waiting site's own sentence.
 */

export function abortReason(signal: AbortSignal, abandoned = "the wait was abandoned"): unknown {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error(abandoned)
  error.name = "AbortError"
  return error
}

export function throwIfAborted(signal: AbortSignal, abandoned?: string): void {
  if (signal.aborted) throw abortReason(signal, abandoned)
}

/** A timer that rejects with the signal's reason when aborted, and leaves no listener behind. */
export function abortableSleep(ms: number, signal: AbortSignal, abandoned?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal, abandoned))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
