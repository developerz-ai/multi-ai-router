import { createHash } from "node:crypto"
import type { AdminSessionRepository, AdminSessionRow } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import { type AdminSession, type SessionStore, sessionExpiryMs } from "./sessionStore"

/** Durable sessions with bounded replica staleness and conditional, non-inserting slides. */
export interface PostgresSessionStoreDeps {
  readonly repository: AdminSessionRepository
  readonly logger: Logger
  readonly cacheMaxEntries: number
  readonly revalidateAfterMs?: number
  readonly now?: () => number
}

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
  const now = deps.now ?? Date.now
  const revalidateAfterMs = deps.revalidateAfterMs ?? 60_000
  const cache = new Map<string, { session: AdminSession; checkedAt: number }>()
  const creates = new Map<string, Promise<void>>()
  const deletions = new Map<string, Promise<void>>()
  // A single bounded generation fences all outstanding reads/touches on local invalidation.
  let generation = 0

  function remember(session: AdminSession): void {
    cache.delete(session.id)
    cache.set(session.id, { session, checkedAt: now() })
    while (cache.size > deps.cacheMaxEntries) {
      const oldest = cache.keys().next()
      if (oldest.done) break
      cache.delete(oldest.value)
    }
  }

  return {
    async get(id) {
      if (deletions.has(id)) return undefined
      const cached = cache.get(id)
      if (cached !== undefined && now() - cached.checkedAt < revalidateAfterMs) {
        return cached.session
      }
      cache.delete(id)
      const started = generation
      const row = await deps.repository.find(hashSessionId(id))
      if (started !== generation || row === undefined) return undefined
      const session = fromRow(id, row)
      remember(session)
      return session
    },
    async create(session) {
      const started = generation
      const write = deps.repository.create(toRow(session))
      creates.set(session.id, write)
      try {
        await write
        if (started === generation) remember(session)
      } finally {
        if (creates.get(session.id) === write) creates.delete(session.id)
      }
    },
    async touch(session) {
      if (deletions.has(session.id)) return false
      const started = generation
      const updated = await deps.repository.touch(toRow(session))
      if (!updated || started !== generation) {
        cache.delete(session.id)
        return false
      }
      remember(session)
      return true
    },
    delete(id) {
      const existing = deletions.get(id)
      if (existing !== undefined) return existing
      generation += 1
      cache.delete(id)
      const remove = async (): Promise<void> => {
        // The tombstone covers the full interval while durable deletion waits for I/O.
        await creates.get(id)?.catch(() => undefined)
        await deps.repository.delete(hashSessionId(id))
      }
      const pending = remove().finally(() => {
        generation += 1
        cache.delete(id)
        deletions.delete(id)
      })
      deletions.set(id, pending)
      return pending
    },
    async deleteExpired(nowMs, limit) {
      generation += 1
      for (const [id, entry] of cache) {
        if (sessionExpiryMs(entry.session) <= nowMs) cache.delete(id)
      }
      return deps.repository.deleteExpiredBefore(new Date(nowMs), limit)
    },
  }
}
