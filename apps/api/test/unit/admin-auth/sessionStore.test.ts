import { describe, expect, test } from "bun:test"
import {
  type AdminSession,
  createMemorySessionStore,
  sessionExpiryMs,
} from "../../../src/services/admin-auth/sessionStore"

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

describe("sessionExpiryMs", () => {
  test("is whichever bound bites first", () => {
    expect(sessionExpiryMs(session())).toBe(1_000)
    expect(sessionExpiryMs(session({ idleExpiryMs: 50_000 }))).toBe(10_000)
  })
})

describe("createMemorySessionStore", () => {
  test("stores, reads back, and overwrites on save", async () => {
    const store = createMemorySessionStore()
    await store.save(session())

    expect(await store.get("session-1")).toMatchObject({ username: "admin" })

    await store.save(session({ lastSeenAtMs: 500, idleExpiryMs: 5_000 }))
    expect(await store.get("session-1")).toMatchObject({ lastSeenAtMs: 500, idleExpiryMs: 5_000 })
  })

  test("returns undefined for an id it never issued", async () => {
    expect(await createMemorySessionStore().get("nope")).toBeUndefined()
  })

  test("delete is a real invalidation, not a flag", async () => {
    const store = createMemorySessionStore()
    await store.save(session())
    await store.delete("session-1")

    expect(await store.get("session-1")).toBeUndefined()
  })

  test("deleteExpired drops sessions past either bound and keeps live ones", async () => {
    const store = createMemorySessionStore()
    await store.save(session({ id: "idle-out", idleExpiryMs: 100, absoluteExpiryMs: 99_999 }))
    await store.save(session({ id: "capped-out", idleExpiryMs: 99_999, absoluteExpiryMs: 100 }))
    await store.save(session({ id: "live", idleExpiryMs: 99_999, absoluteExpiryMs: 99_999 }))

    expect(await store.deleteExpired(1_000)).toBe(2)
    expect(await store.get("live")).toBeDefined()
    expect(await store.get("idle-out")).toBeUndefined()
    expect(await store.get("capped-out")).toBeUndefined()
  })
})
