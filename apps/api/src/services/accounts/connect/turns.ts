/**
 * One account at a time, for the calls that own an Account's single pending CLI login.
 *
 * `begin` reads the pending map, provisions a directory, and starts a subprocess — three steps with
 * two awaits between them. Unqueued, two concurrent calls both find nothing pending, both spawn a
 * `claude`, and only the second is ever recorded. That single window produces two failures at once:
 * the first subprocess is **orphaned** — nothing holds its handle, so no `cancel`, no shutdown, and
 * no TTL can ever reach it — and the timer it armed is keyed by account id alone, so when it fires
 * it discards whatever is pending *then*, killing the second, live login mid-flow.
 *
 * Both are the same defect. The invariant is per account ("one Account has one pending login"), so
 * the read-then-write window has to be closed per account.
 *
 * **A queue, not a share.** The single-flight in `../refresh/refresher.ts` collapses concurrent
 * triggers into one exchange because they all want the same outcome. Here they do not: a second
 * `begin` is an operator pressing the button again, and it must supersede the first. So the second
 * caller runs, and runs *after* — which is exactly what lets it see, and cancel, what it displaces.
 *
 * **Per account, never global.** Many Accounts of one Provider is the normal case (CLAUDE.md), and
 * one login's subprocess handshake must not make the other four operators wait on it.
 */

export interface AccountTurns {
  /**
   * Runs `work` once every turn already queued for `accountId` has settled.
   *
   * A rejection reaches that caller and nobody else: the turn is handed on regardless, so a login
   * that failed to start cannot wedge the account.
   */
  take<T>(accountId: string, work: () => Promise<T>): Promise<T>
  /** Accounts with a turn queued or running. Observability and tests; nothing branches on it. */
  readonly size: number
}

export function createAccountTurns(): AccountTurns {
  // The tail of each account's queue, dropped once it drains: an account that is deleted, or simply
  // never connected again, must not hold an entry for the life of the process.
  const tails = new Map<string, Promise<unknown>>()

  return {
    take: <T>(accountId: string, work: () => Promise<T>): Promise<T> => {
      const previous = tails.get(accountId)
      // A stored tail is the swallowing wrapper below and so never rejects — one failed turn cannot
      // cancel the turns queued behind it.
      const run = previous === undefined ? work() : previous.then(work)
      const forget = (): void => {
        if (tails.get(accountId) === tail) tails.delete(accountId)
      }
      const tail: Promise<unknown> = run.then(forget, forget)
      tails.set(accountId, tail)
      return run
    },

    get size() {
      return tails.size
    },
  }
}
