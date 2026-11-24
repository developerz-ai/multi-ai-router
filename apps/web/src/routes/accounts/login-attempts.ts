export interface LoginAttempts {
  /** Records a start on this account and names it. */
  readonly begin: (id: string) => number
  /** It exists on the router and is on screen. */
  readonly shown: (id: string, attempt: number) => void
  /** It exists on the router and no screen will finish it. */
  readonly orphaned: (id: string, attempt: number) => void
  /** It never came to exist. */
  readonly failed: (id: string, attempt: number) => void
  /** It became a login: nothing of it is left to cancel. */
  readonly finished: (id: string, attempt: number) => void
  readonly newest: (id: string) => number
}

/**
 * Which login the router holds for an account, as far as this screen can tell, so an abandoned one
 * is cancelled and a newer one never is: the cancel names the account, not the attempt.
 *
 * A start counts until it fails, ends, or is covered by a cancel sent after it landed. One still in
 * flight always counts: requests can overtake each other, so it may yet become the login the router
 * holds, whatever happened to the starts after it.
 */
export function createLoginAttempts(cancel: (id: string) => void): LoginAttempts {
  /** Oldest first, per account. */
  const live = new Map<string, readonly number[]>()
  const landed = new Set<number>()
  const orphans = new Set<number>()
  let last = 0

  const newest = (id: string) => live.get(id)?.at(-1) ?? 0

  const drop = (id: string, gone: (attempt: number) => boolean) => {
    const kept = (live.get(id) ?? []).filter((attempt) => {
      if (!gone(attempt)) return true
      landed.delete(attempt)
      orphans.delete(attempt)
      return false
    })
    if (kept.length === 0) live.delete(id)
    else live.set(id, kept)
  }

  /** Cancels when the newest start is one nobody will finish; that covers all that have landed. */
  const settle = (id: string) => {
    if (!orphans.has(newest(id))) return
    drop(id, (attempt) => landed.has(attempt))
    cancel(id)
  }

  return {
    newest,
    begin: (id) => {
      last += 1
      live.set(id, [...(live.get(id) ?? []), last])
      return last
    },
    shown: (_id, attempt) => landed.add(attempt),
    orphaned: (id, attempt) => {
      if (live.get(id)?.includes(attempt) !== true) return
      landed.add(attempt)
      orphans.add(attempt)
      settle(id)
    },
    failed: (id, attempt) => {
      drop(id, (other) => other === attempt)
      settle(id)
    },
    // Those that landed before it were replaced by it on the router.
    finished: (id, attempt) => drop(id, (other) => other <= attempt && landed.has(other)),
  }
}
