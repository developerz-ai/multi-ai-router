import { expect, test } from "bun:test"
import { createSessionStore } from "../../../src/providers"
import { memorySessions, messagesBody } from "./fixtures"

const now = new Date("2026-01-01T00:00:00Z")
const input = {
  apiKeyId: "k",
  sessionKey: "s",
  keySource: "header" as const,
  accountId: "a",
  body: messagesBody([{ role: "user", text: "hi" }]),
}

test("account invalidation drops warm bindings, aliases and late turn remembers", async () => {
  const repo = memorySessions()
  const store = createSessionStore({ repository: repo, now: () => now })
  const turn = store.resolve(input)
  turn.remember("sdk")
  expect(await store.binding("k", "s")).toMatchObject({ accountId: "a", sdkSessionId: "sdk" })
  await store.invalidateAccount("a")
  turn.remember("late")
  turn.release()
  expect(await store.binding("k", "s")).toBeUndefined()
  expect(repo.rows.get("k::s")?.sdkSessionId).toBeNull()
  expect(repo.writes).toHaveLength(1)
})
test("late reads cannot reinstall a deleted account binding", async () => {
  const repo = memorySessions([
    { apiKeyId: "k", key: "s", accountId: "a", sdkSessionId: "old", lastUsedAt: now },
  ])
  const read = Promise.withResolvers<Awaited<ReturnType<typeof repo.findByKey>>>()
  const stale = repo.rows.get("k::s")
  const store = createSessionStore({
    repository: { ...repo, findByKey: () => read.promise },
    now: () => now,
  })
  const binding = store.binding("k", "s")
  await store.invalidateAccount("a")
  read.resolve(stale)
  expect(await binding).toBeUndefined()
})
test("queued remembers from the old generation never reach SQL after deletion", async () => {
  const repo = memorySessions()
  const held = Promise.withResolvers<void>()
  let writes = 0
  const store = createSessionStore({
    repository: {
      ...repo,
      upsert: async (value) => {
        writes++
        if (writes === 1) await held.promise
        return repo.upsert(value)
      },
    },
    now: () => now,
  })
  const turn = store.resolve(input)
  turn.remember("first")
  turn.remember("queued")
  await store.invalidateAccount("a")
  held.resolve()
  await Bun.sleep(0)
  expect(writes).toBe(1)
  turn.release()
})

test("deleting A preserves B pending reads and live remembers", async () => {
  const repo = memorySessions([
    { apiKeyId: "k", key: "b", accountId: "b", sdkSessionId: "old-b", lastUsedAt: now },
  ])
  const read = Promise.withResolvers<Awaited<ReturnType<typeof repo.findByKey>>>()
  const store = createSessionStore({
    repository: { ...repo, findByKey: () => read.promise },
    now: () => now,
  })
  const binding = store.binding("k", "b")
  const turn = store.resolve({ ...input, accountId: "b", sessionKey: "other-b" })
  await store.invalidateAccount("a")
  read.resolve(repo.rows.get("k::b"))
  expect(await binding).toMatchObject({ accountId: "b", sdkSessionId: "old-b" })
  turn.remember("new-b")
  turn.release()
  await Bun.sleep(0)
  expect(repo.rows.get("k::other-b")?.sdkSessionId).toBe("new-b")
})

test("deleting A preserves ordered B writes and queued unrelated clears", async () => {
  const repo = memorySessions()
  const held = Promise.withResolvers<void>()
  let writes = 0
  const store = createSessionStore({
    repository: {
      ...repo,
      upsert: async (value) => {
        if (++writes === 1) await held.promise
        return repo.upsert(value)
      },
    },
    now: () => now,
  })
  const turn = store.resolve({ ...input, accountId: "b" })
  turn.remember("first-b")
  turn.remember("queued-b")
  store.invalidate("k", "s")
  await store.invalidateAccount("a")
  held.resolve()
  await Bun.sleep(0)
  expect(repo.writes.map((row) => row.sdkSessionId)).toEqual(["first-b", "queued-b", null])
  expect(repo.rows.get("k::s")?.accountId).toBeNull()
  turn.release()
})
