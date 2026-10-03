/** Bound shutdown without pretending an issuer or outstanding DB write was canceled remotely. */
export async function drainRefreshWork(
  work: Promise<unknown>,
  timeoutMs: number,
  schedule: (run: () => void, delayMs: number) => () => void,
): Promise<boolean> {
  let cancel = () => {}
  const deadline = new Promise<false>((resolve) => {
    cancel = schedule(() => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([work.then(() => true as const), deadline])
  } finally {
    cancel()
  }
}

export function defaultSchedule(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}
