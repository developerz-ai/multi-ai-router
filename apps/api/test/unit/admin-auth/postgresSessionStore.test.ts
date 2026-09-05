import { describe, expect, test } from "bun:test"
import type { AdminSessionRepository, AdminSessionRow } from "@multi-ai-router/db"
import { createLogger } from "../../../src/logging/logger"
import {
  createPostgresSessionStore,
  hashSessionId,
} from "../../../src/services/admin-auth/postgresSessionStore"
import type { AdminSession } from "../../../src/services/admin-auth/sessionStore"

/**
 * The store's contract over a fake repository — no database. What is asserted
 * is the *shape* of each call: which writes are awaited, which are fired, what
 * the cache absorbs, and that nothing but a hash ever reaches the repository.
 * The SQL underneath is `packages/db/test/integration/admin-session-repository.test.ts`.
 */

function session(overrides: Partial<AdminSession> = {}): AdminSession {
  return {
    id: "session-1",
    username: "admin",
    csrfToken: "csrf",
    createdAtMs: 0,
    lastSeenAtMs: 0,
    idleExpiryMs: 1_000,
    absoluteExpiryMs: 10_000,
    ...overrides,
  }
}

interface FakeRepository extends AdminSessionRepository {
  readonly rows: Map<string, AdminSessionRow>
  readonly calls: string[]
  /** When set, the next `upsert` rejects with it. */
  failNextUpsert: Error | undefined
  /** Resolves every pending `upsert` — they hang until released so a test can observe ordering. */
  releaseUpserts: () => void
}

function fakeRepository(): FakeRepository {
  const rows = new Map<string, AdminSessionRow>()
  const calls: string[] = []
  let pending: Array<() => void> = []
  const repo: FakeRepository = {
    rows,
    calls,
    failNextUpsert: undefined,
    releaseUpserts: () => {
      const batch = pending
      pending = []
      for (const release of batch) release()
    },
    find: async (idHash) => {
      calls.push(`find:${idHash}`)
      return rows.get(idHash)
    },
    upsert: (row) => {
      calls.push(`upsert:${row.idHash}`)
      const failure = repo.failNextUpsert
      repo.failNextUpsert = undefined
      return new Promise<void>((resolve, reject) => {
        pending.push(() => {
          if (failure !== undefined) {
            reject(failure)
            return
          }
          const existing = rows.get(row.idHash)
          rows.set(
            row.idHash,
            existing === undefined
              ? row
              : { ...existing, lastSeenAt: row.lastSeenAt, idleExpiryAt: row.idleExpiryAt },
          )
          resolve()
        })
      })
    },
    delete: async (idHash) => {
      calls.push(`delete:${idHash}`)
      return rows.delete(idHash)
    },
    deleteExpiredBefore: async (cutoff, limit) => {
      calls.push(`deleteExpiredBefore:${cutoff.toISOString()}:${limit}`)
      return 0
    },
  }
  return repo
}

function harness(options: { cacheMaxEntries?: number } = {}) {
  const repository = fakeRepository()
  const lines: string[] = []
  const logger = createLogger({ level: "debug", write: (line) => lines.push(line) })
  const store = createPostgresSessionStore({
    repository,
    logger,
    cacheMaxEntries: options.cacheMaxEntries ?? 100,
  })
  return { repository, lines, store }
}

/** Lets the microtask queue drain so a fired-and-forgotten promise settles. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("hashSessionId", () => {
  test("is deterministic, hex, and not the id", () => {
    expect(hashSessionId("abc")).toBe(hashSessionId("abc"))
    expect(hashSessionId("abc")).toMatch(/^[0-9a-f]{64}$/)
    expect(hashSessionId("abc")).not.toContain("abc")
    expect(hashSessionId("abc")).not.toBe(hashSessionId("abd"))
  })
})

describe("createPostgresSessionStore", () => {
  test("a login save awaits the upsert and the repository only ever sees the hash", async () => {
    const { repository, store } = harness()
    const s = session()

    let saved = false
    const saving = store.save(s).then(() => {
      saved = true
    })
    await settle()
    expect(saved).toBe(false)
    expect(repository.calls).toEqual([`upsert:${hashSessionId(s.id)}`])

    repository.releaseUpserts()
    await saving
    expect(saved).toBe(true)
    expect(repository.rows.get(hashSessionId(s.id))).toMatchObject({ username: "admin" })
    expect(JSON.stringify([...repository.rows.values()])).not.toContain(s.id)
  })

  test("a miss reads the row once and converts it; the second get makes no repository call", async () => {
    const { repository, store } = harness()
    const s = session({ id: "durable", createdAtMs: 5_000, lastSeenAtMs: 6_000 })
    repository.rows.set(hashSessionId(s.id), {
      idHash: hashSessionId(s.id),
      username: s.username,
      csrfToken: s.csrfToken,
      createdAt: new Date(s.createdAtMs),
      lastSeenAt: new Date(s.lastSeenAtMs),
      idleExpiryAt: new Date(s.idleExpiryMs),
      absoluteExpiryAt: new Date(s.absoluteExpiryMs),
    })

    expect(await store.get("durable")).toEqual(s)
    expect(await store.get("durable")).toEqual(s)
    expect(repository.calls).toEqual([`find:${hashSessionId("durable")}`])
  })

  test("an unknown id is a miss, not an error", async () => {
    const { store } = harness()
    expect(await store.get("nope")).toBeUndefined()
  })

  test("a slide save returns before the upsert settles and updates the cache immediately", async () => {
    const { repository, store } = harness()
    const s = session()
    const login = store.save(s)
    repository.releaseUpserts()
    await login

    const slid = { ...s, lastSeenAtMs: 500, idleExpiryMs: 5_000 }
    // Resolves although the fake never released the second upsert.
    await store.save(slid)
    expect(await store.get(s.id)).toEqual(slid)
    expect(repository.calls.filter((c) => c.startsWith("upsert:"))).toHaveLength(2)
    repository.releaseUpserts()
  })

  test("a rejected slide is logged at warn and never thrown", async () => {
    const { repository, lines, store } = harness()
    const s = session()
    const login = store.save(s)
    repository.releaseUpserts()
    await login

    repository.failNextUpsert = new Error("connection reset")
    await store.save({ ...s, lastSeenAtMs: 500 })
    repository.releaseUpserts()
    await settle()

    const warning = lines.find((l) => l.includes("admin session slide not persisted"))
    expect(warning).toBeDefined()
    expect(warning).toContain("connection reset")
    expect(warning).toContain('"level":"warn"')
    expect(warning).not.toContain(s.id)
  })

  test("delete evicts the cache entry and deletes the row by hash", async () => {
    const { repository, store } = harness()
    const s = session()
    const login = store.save(s)
    repository.releaseUpserts()
    await login

    await store.delete(s.id)
    expect(repository.calls).toContain(`delete:${hashSessionId(s.id)}`)
    expect(repository.rows.size).toBe(0)
    // The cache is gone too: the next read goes to the repository and misses.
    expect(await store.get(s.id)).toBeUndefined()
    expect(repository.calls).toContain(`find:${hashSessionId(s.id)}`)
  })

  test("deleteExpired evicts expired cache entries and forwards cutoff and limit", async () => {
    const { repository, store } = harness()
    const dead = session({ id: "dead", idleExpiryMs: 100 })
    const live = session({ id: "live", idleExpiryMs: 99_999, absoluteExpiryMs: 99_999 })
    const logins = Promise.all([store.save(dead), store.save(live)])
    repository.releaseUpserts()
    await logins

    await store.deleteExpired(1_000, 50)
    expect(repository.calls.at(-1)).toBe(`deleteExpiredBefore:${new Date(1_000).toISOString()}:50`)

    // "dead" is out of the cache: a read now consults the repository (which still holds it —
    // the fake's sweep deletes nothing, which is what proves the read was a miss).
    repository.calls.length = 0
    await store.get("dead")
    expect(repository.calls).toEqual([`find:${hashSessionId("dead")}`])
    await store.get("live")
    expect(repository.calls).toEqual([`find:${hashSessionId("dead")}`])
  })

  test("the cache is bounded: the oldest entry is evicted first", async () => {
    const { repository, store } = harness({ cacheMaxEntries: 2 })
    const logins = Promise.all([
      store.save(session({ id: "a" })),
      store.save(session({ id: "b" })),
      store.save(session({ id: "c" })),
    ])
    repository.releaseUpserts()
    await logins

    repository.calls.length = 0
    await store.get("c")
    await store.get("b")
    expect(repository.calls).toEqual([])
    await store.get("a")
    expect(repository.calls).toEqual([`find:${hashSessionId("a")}`])
  })
})
