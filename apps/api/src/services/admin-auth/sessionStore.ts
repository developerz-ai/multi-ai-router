/**
 * Server-side admin session state. The cookie carries an opaque id and nothing else; every fact
 * about a session — who it belongs to, when it dies, its CSRF token — lives here, so logout and
 * expiry are real invalidations rather than a client-side suggestion.
 *
 * Two implementations share the `SessionStore` interface: the in-memory map below, and the
 * durable one in `postgresSessionStore.ts`. **The memory store means what it says** — sessions
 * do not survive a restart, a redeploy, or a crash, and a second replica cannot see the first
 * one's — which is why the composition root wires the Postgres store and this one is kept for
 * tests and for a router deliberately run without durability. The interface is
 * `Promise`-returning for the durable implementation's sake (a map needs no async).
 */

export interface AdminSession {
  /** Opaque, high-entropy, server-generated. Never derived from the username. */
  readonly id: string
  readonly username: string
  /** Synchronizer CSRF token, bound to this session. See `csrf.ts`. */
  readonly csrfToken: string
  readonly createdAtMs: number
  readonly lastSeenAtMs: number
  /** Sliding: recomputed on every authenticated request. */
  readonly idleExpiryMs: number
  /** Fixed at login: no amount of activity extends it. */
  readonly absoluteExpiryMs: number
}

/** The instant a session stops being valid, whichever bound bites first. */
export function sessionExpiryMs(session: AdminSession): number {
  return Math.min(session.idleExpiryMs, session.absoluteExpiryMs)
}

export interface SessionStore {
  get(id: string): Promise<AdminSession | undefined>
  save(session: AdminSession): Promise<void>
  delete(id: string): Promise<void>
  /**
   * Drops sessions already past their expiry, at most `limit` of them, and returns how many went.
   * Exactly `limit` is the caller's "there is more" signal — the same contract every bounded
   * retention delete in the scheduler drains on.
   */
  deleteExpired(nowMs: number, limit: number): Promise<number>
}

export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, AdminSession>()

  return {
    get(id) {
      return Promise.resolve(sessions.get(id))
    },
    save(session) {
      sessions.set(session.id, session)
      return Promise.resolve()
    },
    delete(id) {
      sessions.delete(id)
      return Promise.resolve()
    },
    deleteExpired(nowMs, limit) {
      let removed = 0
      for (const [id, session] of sessions) {
        if (removed >= limit) break
        if (sessionExpiryMs(session) <= nowMs) {
          sessions.delete(id)
          removed += 1
        }
      }
      return Promise.resolve(removed)
    },
  }
}
