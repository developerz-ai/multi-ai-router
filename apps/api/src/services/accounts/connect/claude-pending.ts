import type { ClaudeLoginHandle } from "../../../providers/claude-sdk/login"
import type { ClaudeConnectMode } from "./claude"

/**
 * The registry of logins currently waiting for their `code#state` — one per account, each a live
 * `claude` subprocess with an expiry timer aimed at it.
 *
 * Split out of `claude.ts` because it is the one piece of *state* that service holds, and its rules
 * are its own: a login is released exactly once (the timer is cleared with it, so an expiry can
 * never cancel a login that was already completed), `discard` is the only way one is terminated,
 * and `stop` refuses new entries so a shutdown cannot race a `begin` into an orphaned CLI.
 *
 * In memory, and that is the honest store: a pending login *is* a running subprocess, so a restart
 * kills it and persisting the `state` would only preserve a value no CLI is waiting for.
 */
export interface PendingLogin {
  readonly handle: ClaudeLoginHandle
  readonly configDir: string
  readonly mode: ClaudeConnectMode
  readonly expiresAt: Date
}

export interface PendingLogins {
  /** Registers a login and arms its expiry, discarding whatever was pending for the account. */
  hold(accountId: string, login: PendingLogin, ttlMs: number): void
  /** Removes a pending login without terminating it — the caller is about to complete it. */
  release(accountId: string): PendingLogin | undefined
  /** Removes and terminates a pending login. */
  discard(accountId: string): void
  /** True once {@link stop} ran: nothing may be held after that. */
  readonly stopping: boolean
  /** Terminates every pending login and refuses any still starting. */
  stop(): void
}

interface Held extends PendingLogin {
  readonly timer: ReturnType<typeof setTimeout>
}

export function createPendingLogins(): PendingLogins {
  const pending = new Map<string, Held>()
  let stopping = false

  const release = (accountId: string): PendingLogin | undefined => {
    const found = pending.get(accountId)
    if (found === undefined) return undefined
    pending.delete(accountId)
    clearTimeout(found.timer)
    return found
  }

  const discard = (accountId: string): void => {
    release(accountId)?.handle.cancel()
  }

  return {
    hold: (accountId, login, ttlMs) => {
      discard(accountId)
      const timer = setTimeout(() => discard(accountId), ttlMs)
      timer.unref?.()
      pending.set(accountId, { ...login, timer })
    },
    release,
    discard,
    get stopping() {
      return stopping
    },
    stop: () => {
      stopping = true
      for (const accountId of [...pending.keys()]) discard(accountId)
    },
  }
}
