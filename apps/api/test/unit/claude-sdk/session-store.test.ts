import { describe, expect, test } from "bun:test"
import { createSessionStore, type SessionStore } from "../../../src/providers"
import { type MemorySessions, memorySessions, messagesBody, ticker } from "./fixtures"

/**
 * The store: Postgres is the persisted truth, the LRU pair is the cache, and neither is allowed to
 * cost a request its answer (docs/idea/11-anthropic-agent-sdk.md §4).
 *
 * Three properties are asserted here rather than assumed. A hit costs no query and a miss costs
 * exactly one, because the performance budget allows that shape and no other. A binding is dropped
 * and never moved, because an SDK session id resumes only on the Account that minted it. And every
 * failure degrades to "no binding", because a slow session table must cost a cold prompt cache, not
 * a failed request.
 */

const NOW = new Date("2026-01-01T12:00:00.000Z")

function storeWith(repository: MemorySessions, clock = ticker()): SessionStore {
  return createSessionStore({
    repository,
    now: () => NOW,
    cache: { maxEntries: 16, ttlMs: 1_000, negativeTtlMs: 100, now: clock.now },
  })
}

const opening = messagesBody([{ role: "user", text: "hello" }])
const grown = messagesBody([
  { role: "user", text: "hello" },
  { role: "assistant", text: "hi" },
  { role: "user", text: "and now?" },
])

/** One turn: resolve the plan for an account, then record whatever session the SDK named. */
function turn(store: SessionStore, body: Uint8Array, sdkSessionId: string | null, uuid?: string) {
  const resolved = store.resolve({
    apiKeyId: "key-1",
    sessionKey: "conv-1",
    keySource: "header",
    accountId: "acct-1",
    body,
  })
  if (sdkSessionId !== null) resolved.remember(sdkSessionId, uuid)
  return resolved.plan
}

describe("reading a binding on the request path", () => {
  test("a miss costs one indexed query and is remembered, so the next one costs none", async () => {
    const repository = memorySessions()
    const store = storeWith(repository)

    expect(await store.binding("key-1", "conv-1")).toBeUndefined()
    expect(await store.binding("key-1", "conv-1")).toBeUndefined()

    expect(repository.reads).toBe(1)
  })

  test("a miss is re-read once its short clock runs out", async () => {
    const clock = ticker()
    const repository = memorySessions()
    const store = storeWith(repository, clock)

    await store.binding("key-1", "conv-1")
    clock.advance(101)
    await store.binding("key-1", "conv-1")

    expect(repository.reads).toBe(2)
  })

  test("a stored row is returned as the binding, and then served from memory", async () => {
    const repository = memorySessions([
      {
        apiKeyId: "key-1",
        key: "conv-1",
        accountId: "acct-1",
        sdkSessionId: "sess_1",
        lastUsedAt: NOW,
      },
    ])
    const store = storeWith(repository)

    expect(await store.binding("key-1", "conv-1")).toMatchObject({
      accountId: "acct-1",
      sdkSessionId: "sess_1",
    })
    await store.binding("key-1", "conv-1")
    expect(repository.reads).toBe(1)
  })

  test("a row naming an account but no session id binds nothing — it resumes nowhere", async () => {
    const repository = memorySessions([
      { apiKeyId: "key-1", key: "conv-1", accountId: "acct-1", lastUsedAt: NOW },
    ])

    expect(await storeWith(repository).binding("key-1", "conv-1")).toBeUndefined()
  })

  test("two keys sending the same session name never see each other's binding", async () => {
    const repository = memorySessions([
      {
        apiKeyId: "key-1",
        key: "shared",
        accountId: "acct-1",
        sdkSessionId: "sess_1",
        lastUsedAt: NOW,
      },
    ])
    const store = storeWith(repository)

    expect(await store.binding("key-1", "shared")).toMatchObject({ sdkSessionId: "sess_1" })
    expect(await store.binding("key-2", "shared")).toBeUndefined()
  })

  test("a failing read is not remembered as a missing binding", async () => {
    const repository = memorySessions()
    const seen: string[] = []
    const store = createSessionStore({
      repository,
      now: () => NOW,
      onError: (operation) => seen.push(operation),
    })

    repository.fail("read")
    expect(await store.binding("key-1", "conv-1")).toBeUndefined()
    repository.fail(null)
    await store.binding("key-1", "conv-1")

    expect(seen).toEqual(["read"])
    expect(repository.reads).toBe(2)
  })
})

describe("resolving a turn against an account", () => {
  test("the first turn is fresh, and the second resumes what the SDK named", () => {
    const store = storeWith(memorySessions())

    expect(turn(store, opening, "sess_1")).toEqual({ kind: "fresh", reason: "no-session" })

    const plan = turn(store, grown, "sess_1")
    expect(plan.kind).toBe("resume")
    if (plan.kind !== "resume") return
    expect(plan.sdkSessionId).toBe("sess_1")
    expect(plan.lineage).toBe("continuation")
  })

  test("the row carries the hashes and the uuid the next undo will rewind to", () => {
    const repository = memorySessions()
    const store = storeWith(repository)

    turn(store, opening, "sess_1", "uuid-1")

    const written = repository.writes.at(-1)
    expect(written?.accountId).toBe("acct-1")
    expect(written?.sdkSessionId).toBe("sess_1")
    expect(written?.fingerprintSource).toBe("header")
    expect(written?.lineageState?.prefixHashes).toHaveLength(1)
    // One past the end: that is where the client will send this answer back next turn.
    expect(written?.lineageState?.assistantUuids).toEqual(["", "uuid-1"])
  })

  test("nothing is written until the SDK names a session — an unbound account is not a pin", () => {
    const repository = memorySessions()
    const store = storeWith(repository)

    store.resolve({
      apiKeyId: "key-1",
      sessionKey: "conv-1",
      keySource: "header",
      accountId: "acct-1",
      body: opening,
    })

    expect(repository.writes).toHaveLength(0)
  })

  test("a session minted on one account is invisible to another", () => {
    const store = storeWith(memorySessions())

    turn(store, opening, "sess_1")
    const elsewhere = store.resolve({
      apiKeyId: "key-1",
      sessionKey: "conv-1",
      keySource: "header",
      accountId: "acct-2",
      body: grown,
    })

    expect(elsewhere.plan).toEqual({ kind: "fresh", reason: "no-session" })
  })

  test("a headerless client whose session key shifted still finds its session by fingerprint", () => {
    const store = storeWith(memorySessions())

    store
      .resolve({
        apiKeyId: "key-1",
        sessionKey: "fp_first",
        keySource: "fingerprint",
        accountId: "acct-1",
        body: opening,
      })
      .remember("sess_1")

    const later = store.resolve({
      apiKeyId: "key-1",
      sessionKey: "fp_second",
      keySource: "fingerprint",
      accountId: "acct-1",
      body: grown,
    })

    expect(later.plan.kind).toBe("resume")
    if (later.plan.kind !== "resume") return
    expect(later.plan.sdkSessionId).toBe("sess_1")
  })

  test("an unreadable body neither resumes nor records anything", () => {
    const repository = memorySessions()
    const store = storeWith(repository)

    const resolved = store.resolve({
      apiKeyId: "key-1",
      sessionKey: "conv-1",
      keySource: "header",
      accountId: "acct-1",
      body: new TextEncoder().encode("not json"),
    })
    resolved.remember("sess_1")

    expect(resolved.plan).toEqual({ kind: "fresh", reason: "unreadable-body" })
    expect(repository.writes).toHaveLength(0)
  })

  test("a failing write is reported and never thrown at the request", async () => {
    const repository = memorySessions()
    const seen: string[] = []
    const store = createSessionStore({
      repository,
      now: () => NOW,
      onError: (operation) => seen.push(operation),
    })

    repository.fail("write")
    expect(() => turn(store, opening, "sess_1")).not.toThrow()
    await Promise.resolve()

    expect(seen).toEqual(["write"])
  })
})

describe("invalidating a binding", () => {
  test("clears both halves in Postgres and answers unbound from memory at once", async () => {
    const repository = memorySessions([
      {
        apiKeyId: "key-1",
        key: "conv-1",
        accountId: "acct-1",
        sdkSessionId: "sess_1",
        lastUsedAt: NOW,
      },
    ])
    const store = storeWith(repository)

    await store.binding("key-1", "conv-1")
    store.invalidate("key-1", "conv-1")

    expect(await store.binding("key-1", "conv-1")).toBeUndefined()
    const written = repository.writes.at(-1)
    expect(written?.accountId).toBeNull()
    expect(written?.sdkSessionId).toBeNull()
    expect(written?.lineageState).toBeNull()
  })

  test("the invalidated session is not resumed on the account it moves to", () => {
    const store = storeWith(memorySessions())

    turn(store, opening, "sess_1")
    store.invalidate("key-1", "conv-1")

    const next = store.resolve({
      apiKeyId: "key-1",
      sessionKey: "conv-1",
      keySource: "header",
      accountId: "acct-1",
      body: grown,
    })

    expect(next.plan).toEqual({ kind: "fresh", reason: "no-session" })
  })
})

/**
 * The row writes are fire-and-forget — nothing on the request path waits on Postgres — but within
 * one session they must land in the order they were issued. An invalidate's clear and a rebind's
 * bind used to be two independent floating upserts: the clear landing second left an empty row
 * behind a cache that says bound, and the next replica to warm from that row started cold.
 */
describe("row writes are ordered per session", () => {
  interface GatedSessions {
    readonly repository: Parameters<typeof createSessionStore>[0]["repository"]
    /** `sdkSessionId` of each landed write, in landing order. `null` is a clear. */
    readonly landed: (string | null)[]
    /** Makes the next upsert wait until `release()` is called. */
    hold(): void
    release(): void
  }

  function gatedSessions(): GatedSessions {
    const landed: (string | null)[] = []
    let gate: Promise<void> | null = null
    let open: () => void = () => {}
    return {
      landed,
      hold() {
        gate = new Promise((resolve) => {
          open = resolve
        })
      },
      release: () => open(),
      repository: {
        findByKey: async () => undefined,
        upsert: async (input) => {
          const wait = gate
          gate = null
          if (wait !== null) await wait
          landed.push(input.sdkSessionId ?? null)
          return {
            id: `${input.apiKeyId}::${input.key}`,
            key: input.key,
            apiKeyId: input.apiKeyId,
            accountId: input.accountId ?? null,
            sdkSessionId: input.sdkSessionId ?? null,
            lineageState: input.lineageState ?? null,
            fingerprintSource: input.fingerprintSource ?? null,
            lastUsedAt: input.lastUsedAt,
            createdAt: input.lastUsedAt,
          }
        },
      },
    }
  }

  async function until(check: () => boolean): Promise<void> {
    for (let tries = 0; tries < 200 && !check(); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }

  test("a slow clear still lands before the rebind's bind that followed it", async () => {
    const gate = gatedSessions()
    const store = createSessionStore({ repository: gate.repository, now: () => NOW })

    gate.hold()
    store.invalidate("key-1", "conv-1")

    // The rebind, immediately behind it: the same session, freshly placed on another account.
    store
      .resolve({
        apiKeyId: "key-1",
        sessionKey: "conv-1",
        keySource: "header",
        accountId: "acct-2",
        body: opening,
      })
      .remember("sess_2")

    gate.release()
    await until(() => gate.landed.length === 2)

    expect(gate.landed).toEqual([null, "sess_2"])
  })

  test("two sessions never wait on each other's writes", async () => {
    const gate = gatedSessions()
    const store = createSessionStore({ repository: gate.repository, now: () => NOW })

    gate.hold()
    store.invalidate("key-1", "conv-1")
    store.invalidate("key-1", "conv-2")
    await until(() => gate.landed.length === 1)

    // conv-2's clear landed while conv-1's is still held.
    expect(gate.landed).toEqual([null])
    gate.release()
    await until(() => gate.landed.length === 2)
    expect(gate.landed).toHaveLength(2)
  })
})
