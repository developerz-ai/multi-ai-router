import { createHash } from "node:crypto"
import { describeError } from "@multi-ai-router/core"
import type { AdminSessionRepository, AdminSessionRow } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import { type AdminSession, type SessionStore, sessionExpiryMs } from "./sessionStore"

/**
 * The durable `SessionStore`: a row in `admin_sessions` per live console session, so a restart, a
 * redeploy, or a crash no longer logs the operator out, and every replica honours a cookie any
 * other one issued.
 *
 * **The id is stored hashed.** The cookie carries the opaque session id and that id is the
 * bearer; the row is keyed by its SHA-256 (`hashSessionId`) and never holds the id itself, so a
 * dump of the table cannot be turned into a cookie. **The CSRF token is stored as-is** — the SPA
 * reads it back on every session read to compare against the header, so it cannot be one-way
 * hashed, and it is worthless without the cookie the table refuses to store.
 *
 * **The cache is per replica; the write coalescing lives in the service.** `get` is answered from
 * a bounded in-memory read-through cache so an admin request does not cost a Postgres round trip;
 * a miss reads the row once. `authenticate()` in `service.ts` already gates how often a slide
 * reaches `save`, so this store never gates again — it only decides *how* to persist: a login
 * (an id the cache has never seen) is awaited, because a session must be durable before the
 * cookie goes out; a slide (an id already cached) is fire-and-forget, because a lost slide costs
 * at most one idle window's worth of lag on a row `authenticate()` will slide again, and a
 * rejected write must never turn a valid session into a `500`.
 *
 * The cache is not a coherence protocol: a logout on replica A deletes the row, and replica B's
 * cached copy lives until it expires or is evicted. Single-replica is the deployed shape
 * (docs/idea/01-architecture.md), and the cache's expiry check in `get` bounds the exposure to the
 * session's own idle window even where it is not.
 */

export interface PostgresSessionStoreDeps {
  readonly repository: AdminSessionRepository
  readonly logger: Logger
  /** Ceiling on cached sessions per replica. Insertion-order eviction past it. */
  readonly cacheMaxEntries: number
}

/** The row key for a session id: SHA-256 hex. Pure, so the same id always names the same row. */
export function hashSessionId(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex")
}

function toRow(session: AdminSession): AdminSessionRow {
  return {
    idHash: hashSessionId(session.id),
    username: session.username,
    csrfToken: session.csrfToken,
    createdAt: new Date(session.createdAtMs),
    lastSeenAt: new Date(session.lastSeenAtMs),
    idleExpiryAt: new Date(session.idleExpiryMs),
    absoluteExpiryAt: new Date(session.absoluteExpiryMs),
  }
}

/** The raw id comes from the caller — the row cannot supply it, by design. */
function fromRow(id: string, row: AdminSessionRow): AdminSession {
  return {
    id,
    username: row.username,
    csrfToken: row.csrfToken,
    createdAtMs: row.createdAt.getTime(),
    lastSeenAtMs: row.lastSeenAt.getTime(),
    idleExpiryMs: row.idleExpiryAt.getTime(),
    absoluteExpiryMs: row.absoluteExpiryAt.getTime(),
  }
}

export function createPostgresSessionStore(deps: PostgresSessionStoreDeps): SessionStore {
  const { repository, logger, cacheMaxEntries } = deps
  /** Keyed by the raw id: this map never leaves the process, so the hash buys nothing here. */
  const cache = new Map<string, AdminSession>()

  function remember(session: AdminSession): void {
    // Re-insert so a refreshed entry moves to the back of the eviction order.
    cache.delete(session.id)
    cache.set(session.id, session)
    while (cache.size > cacheMaxEntries) {
      const oldest = cache.keys().next()
      if (oldest.done) break
      cache.delete(oldest.value)
    }
  }

  return {
    async get(id) {
      const cached = cache.get(id)
      if (cached !== undefined) return cached
      const row = await repository.find(hashSessionId(id))
      if (row === undefined) return undefined
      const session = fromRow(id, row)
      remember(session)
      return session
    },

    async save(session) {
      const isSlide = cache.has(session.id)
      remember(session)
      const write = repository.upsert(toRow(session))
      if (!isSlide) {
        await write
        return
      }
      write.catch((error: unknown) => {
        logger.warn("admin session slide not persisted", {
          username: session.username,
          error: describeError(error, 500),
        })
      })
    },

    async delete(id) {
      cache.delete(id)
      await repository.delete(hashSessionId(id))
    },

    async deleteExpired(nowMs, limit) {
      for (const [id, session] of cache) {
        if (sessionExpiryMs(session) <= nowMs) cache.delete(id)
      }
      return repository.deleteExpiredBefore(new Date(nowMs), limit)
    },
  }
}
