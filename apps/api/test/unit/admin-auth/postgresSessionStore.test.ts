import { expect, test } from "bun:test"
import type { AdminSessionRepository, AdminSessionRow } from "@multi-ai-router/db"
import { createLogger } from "../../../src/logging/logger"
import {
  createPostgresSessionStore,
  hashSessionId,
} from "../../../src/services/admin-auth/postgresSessionStore"
import { type AdminSession, sessionExpiryMs } from "../../../src/services/admin-auth/sessionStore"

function session(id = "session-1"): AdminSession {
  return {
    id,
    username: "admin",
    csrfToken: "csrf",
    createdAtMs: 0,
    lastSeenAtMs: 0,
    idleExpiryMs: 1_000,
    absoluteExpiryMs: 10_000,
  }
}

function deferred() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function harness() {
  const rows = new Map<string, AdminSessionRow>()
  let now = 0
  let reads = 0
  let readGate: ReturnType<typeof deferred> | undefined
  let writeGate: ReturnType<typeof deferred> | undefined
  const repository: AdminSessionRepository = {
    find: async (id) => {
      reads++
      const row = rows.get(id)
      await readGate?.promise
      return row
    },
    create: async (row) => {
      await writeGate?.promise
      rows.set(row.idHash, row)
    },
    touch: async (row) => {
      await writeGate?.promise
      const old = rows.get(row.idHash)
      if (
        old === undefined ||
        Math.min(old.idleExpiryAt.getTime(), old.absoluteExpiryAt.getTime()) <=
          row.lastSeenAt.getTime()
      )
        return false
      rows.set(row.idHash, { ...old, lastSeenAt: row.lastSeenAt, idleExpiryAt: row.idleExpiryAt })
      return true
    },
    delete: async (id) => rows.delete(id),
    deleteExpiredBefore: async (at, limit) => {
      let deleted = 0
      for (const [id, row] of rows) {
        if (
          deleted < limit &&
          Math.min(row.idleExpiryAt.getTime(), row.absoluteExpiryAt.getTime()) <= at.getTime()
        ) {
          rows.delete(id)
          deleted++
        }
      }
      return deleted
    },
  }
  const replica = (cacheMaxEntries = 10) =>
    createPostgresSessionStore({
      repository,
      logger: createLogger({ level: "silent" }),
      cacheMaxEntries,
      revalidateAfterMs: 100,
      now: () => now,
    })
  return {
    rows,
    repository,
    replica,
    reads: () => reads,
    advance: (ms: number) => {
      now += ms
    },
    pauseReads: () => {
      readGate = deferred()
      return readGate
    },
    pauseWrites: () => {
      writeGate = deferred()
      return writeGate
    },
  }
}

test("session hashes are deterministic, distinct, and conceal the bearer", () => {
  expect(hashSessionId("abc")).toMatch(/^[a-f0-9]{64}$/)
  expect(hashSessionId("abc")).toBe(hashSessionId("abc"))
  expect(hashSessionId("abc")).not.toBe(hashSessionId("abd"))
})

test("initial creation waits for durable storage before caching", async () => {
  const h = harness()
  const store = h.replica()
  const gate = h.pauseWrites()
  let done = false
  const pending = store.create(session()).then(() => {
    done = true
  })
  await Promise.resolve()
  expect(done).toBe(false)
  gate.release()
  await pending
  expect(await store.get(session().id)).toEqual(session())
  expect(JSON.stringify([...h.rows.values()])).not.toContain(session().id)
})

test("reads coalesce in cache until bounded revalidation", async () => {
  const h = harness()
  const first = h.replica()
  await first.create(session())
  const second = h.replica()
  expect(await second.get(session().id)).toEqual(session())
  await second.get(session().id)
  expect(h.reads()).toBe(1)
  h.advance(100)
  await second.get(session().id)
  expect(h.reads()).toBe(2)
})

test("a stale replica slide cannot recreate a logged-out row", async () => {
  const h = harness()
  const first = h.replica()
  const second = h.replica()
  await first.create(session())
  await second.get(session().id)
  await first.delete(session().id)
  expect(await second.touch({ ...session(), lastSeenAtMs: 1 })).toBe(false)
  expect(h.rows.size).toBe(0)
  expect(await second.get(session().id)).toBeUndefined()
})

test("remote logout becomes visible even without a slide", async () => {
  const h = harness()
  const first = h.replica()
  const second = h.replica()
  await first.create(session())
  await second.get(session().id)
  await first.delete(session().id)
  h.advance(100)
  expect(await second.get(session().id)).toBeUndefined()
})

test("a read begun before logout cannot repopulate the cache", async () => {
  const h = harness()
  await h.replica().create(session())
  const store = h.replica()
  const gate = h.pauseReads()
  const pending = store.get(session().id)
  await store.delete(session().id)
  gate.release()
  expect(await pending).toBeUndefined()
  expect(await store.get(session().id)).toBeUndefined()
})

test("an in-flight touch cannot resurrect a local logout", async () => {
  const h = harness()
  const store = h.replica()
  await store.create(session())
  const gate = h.pauseWrites()
  const pending = store.touch({ ...session(), lastSeenAtMs: 1 })
  await store.delete(session().id)
  gate.release()
  expect(await pending).toBe(false)
  expect(await store.get(session().id)).toBeUndefined()
})

test("logout waits out initial creation and removes its durable result", async () => {
  const h = harness()
  const store = h.replica()
  const gate = h.pauseWrites()
  const create = store.create(session())
  const logout = store.delete(session().id)
  gate.release()
  await Promise.all([create, logout])
  expect(await store.get(session().id)).toBeUndefined()
})

test("touch fails for absent or expired sessions and preserves a live slide", async () => {
  const h = harness()
  const store = h.replica()
  expect(await store.touch(session())).toBe(false)
  await store.create(session())
  const slid = { ...session(), lastSeenAtMs: 500, idleExpiryMs: 1_500 }
  expect(await store.touch(slid)).toBe(true)
  expect(await store.get(session().id)).toEqual(slid)
  expect(await store.touch({ ...slid, lastSeenAtMs: sessionExpiryMs(slid) })).toBe(false)
})

test("expiry sweeps are bounded and cache eviction respects capacity", async () => {
  const h = harness()
  const store = h.replica(2)
  for (const id of ["a", "b", "c"]) await store.create(session(id))
  await store.get("b")
  expect(h.reads()).toBe(0)
  await store.get("a")
  expect(h.reads()).toBe(1)
  expect(await store.deleteExpired(1_000, 1)).toBe(1)
  expect(h.rows.size).toBe(2)
})

test("a failed initial write never becomes an authenticated cached session", async () => {
  const h = harness()
  h.repository.create = async () => {
    throw new Error("write unavailable")
  }
  const store = h.replica()
  await expect(store.create(session())).rejects.toThrow("write unavailable")
  expect(await store.get(session().id)).toBeUndefined()
})

test("reads and slides during a pending logout cannot restore its cache", async () => {
  const h = harness()
  const store = h.replica()
  await store.create(session())
  const deletion = deferred()
  h.repository.delete = async (id) => {
    await deletion.promise
    return h.rows.delete(id)
  }
  const pending = store.delete(session().id)
  expect(await store.get(session().id)).toBeUndefined()
  expect(await store.touch({ ...session(), lastSeenAtMs: 1 })).toBe(false)
  deletion.release()
  await pending
  expect(await store.get(session().id)).toBeUndefined()
})
