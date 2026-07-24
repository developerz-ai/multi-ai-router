/**
 * Server-side admin session state. The cookie carries an opaque id and nothing else; every fact
 * about a session — who it belongs to, when it dies, its CSRF token — lives here, so logout and
 * expiry are real invalidations rather than a client-side suggestion.
 *
 * **This store is in memory, and that means what it says.** Sessions do not survive a restart,
 * a redeploy, or a crash, and a second replica cannot see the first one's sessions: `docker
 * compose up -d` logs the operator out. That is the current, honest state — not durability with
 * a caveat. The `SessionStore` interface exists so a Postgres-backed implementation can replace
 * this one without a single caller changing, and it is `Promise`-returning **for that reason
 * alone** (an in-memory map needs no async).
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
  /** Drops every session already past its expiry. Returns how many. */
  deleteExpired(nowMs: number): Promise<number>
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
    deleteExpired(nowMs) {
      let removed = 0
      for (const [id, session] of sessions) {
        if (sessionExpiryMs(session) <= nowMs) {
          sessions.delete(id)
          removed += 1
        }
      }
      return Promise.resolve(removed)
    },
  }
}
