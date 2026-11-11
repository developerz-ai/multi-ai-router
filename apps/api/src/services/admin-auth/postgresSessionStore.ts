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
  // The fence is per id: a delete stamps its id with the next sequence number, and a read, touch
  // or create that began before that stamp discards its result. A global counter here made any
  // logout or purge sweep 401 an unrelated operator whose revalidation was in flight. The stamps
  // only matter to operations still in flight, so the map is cleared whenever none are.
  let sequence = 0
  const invalidatedAt = new Map<string, number>()
  let inFlight = 0

  function invalidate(id: string): void {
    sequence += 1
    invalidatedAt.set(id, sequence)
    cache.delete(id)
  }

  function invalidatedSince(id: string, started: number): boolean {
    return (invalidatedAt.get(id) ?? 0) > started
  }

  /** Runs `work` with the sequence number it started at, keeping the stamps alive meanwhile. */
  async function fenced<T>(work: (started: number) => Promise<T>): Promise<T> {
    inFlight += 1
    try {
      return await work(sequence)
    } finally {
      inFlight -= 1
      if (inFlight === 0) invalidatedAt.clear()
    }
  }

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
      return fenced(async (started) => {
        const row = await deps.repository.find(hashSessionId(id))
        if (row === undefined || invalidatedSince(id, started)) return undefined
        const session = fromRow(id, row)
        remember(session)
        return session
      })
    },
    async create(session) {
      const write = deps.repository.create(toRow(session))
      creates.set(session.id, write)
      try {
        await fenced(async (started) => {
          await write
          if (!invalidatedSince(session.id, started)) remember(session)
        })
      } finally {
        if (creates.get(session.id) === write) creates.delete(session.id)
      }
    },
    async touch(session) {
      if (deletions.has(session.id)) return false
      return fenced(async (started) => {
        const written = await deps.repository.touch(toRow(session))
        if (!written || invalidatedSince(session.id, started)) {
          cache.delete(session.id)
          return false
        }
        remember(session)
        return true
      })
    },
    delete(id) {
      const existing = deletions.get(id)
      if (existing !== undefined) return existing
      invalidate(id)
      const remove = async (): Promise<void> => {
        // The tombstone covers the full interval while durable deletion waits for I/O.
        await creates.get(id)?.catch(() => undefined)
        await deps.repository.delete(hashSessionId(id))
      }
      const pending = remove().finally(() => {
        invalidate(id)
        deletions.delete(id)
      })
      deletions.set(id, pending)
      return pending
    },
    async deleteExpired(nowMs, limit) {
      // No fence: a row this sweep removes is already past its expiry, and `authenticate` refuses
      // an expired session on its own. Fencing every in-flight read here was what logged out
      // unrelated operators on each purge.
      for (const [id, entry] of cache) {
        if (sessionExpiryMs(entry.session) <= nowMs) cache.delete(id)
      }
      return deps.repository.deleteExpiredBefore(new Date(nowMs), limit)
    },
  }
}
