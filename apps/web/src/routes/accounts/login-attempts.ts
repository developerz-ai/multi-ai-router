export interface LoginAttempts {
  /** Records a start on this account and names it. */
  readonly begin: (id: string) => number
  /** It landed and the screen shows it: whatever came before it is replaced on the router. */
  readonly shown: (id: string, attempt: number) => void
  /** It exists on the router and no screen will finish it. */
  readonly orphaned: (id: string, attempt: number) => void
  /** It never came to exist. */
  readonly failed: (id: string, attempt: number) => void
  readonly newest: (id: string) => number
}

/**
 * Which login the router holds for an account, as far as this screen can tell, so an abandoned one
 * is cancelled and a newer one never is: the cancel names the account, not the attempt.
 *
 * Only a start that did not fail counts as having replaced the one before it. A slow first start
 * whose replacement never reached the router is still the one that is pending there.
 */
export function createLoginAttempts(cancel: (id: string) => void): LoginAttempts {
  /** Starts not known to have failed or to have been replaced, oldest first. */
  const live = new Map<string, number[]>()
  const orphans = new Set<number>()
  let last = 0

  const newest = (id: string) => live.get(id)?.at(-1) ?? 0

  const settle = (id: string) => {
    const attempt = newest(id)
    if (!orphans.delete(attempt)) return
    live.delete(id)
    cancel(id)
  }

  return {
    newest,
    begin: (id) => {
      last += 1
      live.set(id, [...(live.get(id) ?? []), last])
      return last
    },
    shown: (id, attempt) =>
      live.set(
        id,
        (live.get(id) ?? []).filter((other) => other >= attempt),
      ),
    orphaned: (id, attempt) => {
      if (live.get(id)?.includes(attempt) !== true) return
      orphans.add(attempt)
      settle(id)
    },
    failed: (id, attempt) => {
      live.set(
        id,
        (live.get(id) ?? []).filter((other) => other !== attempt),
      )
      settle(id)
    },
  }
}
