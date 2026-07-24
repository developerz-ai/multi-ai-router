import { describe, expect, test } from "bun:test"
import { isRouterKey, ROUTER_KEY_DISPLAY_PREFIX_LENGTH } from "@multi-ai-router/core"
import { createAuditRecorder } from "../../../src/services/admin"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import { createKeyBody, createKeysService, updateKeyBody } from "../../../src/services/keys"
import { createMemoryStore, type MemoryStore } from "../../support/memory-store"

/**
 * Router keys are encrypted, not hashed, and retrievable at any time — so the
 * central test here is a **round trip**: what the mint returned and what a later
 * reveal returns are the same string, with no rotation in between and no
 * shown-once flow to work around (CLAUDE.md non-negotiable 5).
 */

const NOW = new Date("2026-07-24T12:00:00.000Z")

function harness(now: Date = NOW): {
  service: ReturnType<typeof createKeysService>
  store: MemoryStore
} {
  const store = createMemoryStore()
  const service = createKeysService({
    keys: store.keys,
    pools: store.pools,
    accounts: store.accounts,
    cipher: createCredentialCipher({ key: new Uint8Array(32).fill(3) }),
    audit: createAuditRecorder(store.audit),
    now: () => now,
  })
  return { service, store }
}

async function minted(service: ReturnType<typeof createKeysService>, name = "sebastian-laptop") {
  const result = await service.create({ name })
  if (!result.ok) throw new Error(`create failed: ${result.failure.message}`)
  return result.value
}

describe("create", () => {
  test("mints a well-formed key, stores it encrypted, and indexes its display prefix", async () => {
    const { service, store } = harness()
    const key = await minted(service)

    expect(isRouterKey(key.value)).toBe(true)
    expect(key.prefix).toBe(key.value.slice(0, ROUTER_KEY_DISPLAY_PREFIX_LENGTH))

    const row = store.rows.keys[0]
    expect(row?.value).toStartWith("v1.k1.")
    expect(row?.value).not.toContain(key.value)
  })

  test("defaults to full scope and records no targets", async () => {
    const { service, store } = harness()
    const key = await minted(service)
    expect(key.scope).toEqual({ kind: "all", poolIds: [], accountIds: [] })
    expect(store.rows.keyPools).toHaveLength(0)
    expect(store.rows.keyAccounts).toHaveLength(0)
  })

  test("writes scope targets when the scope names pools", async () => {
    const { service, store } = harness()
    const pool = await store.pools.create({ name: "team" })
    const result = await service.create({
      name: "ci-agent-3",
      scope: { kind: "pools", poolIds: [pool.id] },
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.scope.poolIds).toEqual([pool.id])
    expect(store.rows.keyPools).toHaveLength(1)
  })

  test("a scope naming an unknown pool is rejected before the key is minted", async () => {
    const { service, store } = harness()
    const result = await service.create({
      name: "ci-agent-3",
      scope: { kind: "pools", poolIds: ["11111111-1111-4111-8111-111111111111"] },
    })

    expect(result.ok).toBe(false)
    expect(store.rows.keys).toHaveLength(0)
    expect(store.rows.audit).toHaveLength(0)
  })

  test("an expiry already in the past is refused — the key would work for nothing", async () => {
    const { service } = harness()
    const result = await service.create({
      name: "stale",
      expiresAt: new Date(NOW.getTime() - 1000),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe("expiry_in_past")
  })

  test("names are unique per deployment", async () => {
    const { service } = harness()
    await minted(service)
    const again = await service.create({ name: "sebastian-laptop" })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.failure.status).toBe(409)
  })
})

describe("reveal", () => {
  test("round-trips the same plaintext the mint returned, as often as asked", async () => {
    const { service } = harness()
    const key = await minted(service)

    const first = await service.reveal(key.id)
    const second = await service.reveal(key.id)

    expect(first.ok && first.value.value).toBe(key.value)
    expect(second.ok && second.value.value).toBe(key.value)
  })

  test("editing the key never changes its value", async () => {
    const { service } = harness()
    const key = await minted(service)
    await service.update(key.id, { name: "renamed" })

    const revealed = await service.reveal(key.id)
    expect(revealed.ok && revealed.value.value).toBe(key.value)
    expect(revealed.ok && revealed.value.name).toBe("renamed")
  })

  test("is itself audited, and the audit row carries no key material", async () => {
    const { service, store } = harness()
    const key = await minted(service)
    await service.reveal(key.id)

    const event = store.rows.audit.at(-1)
    expect(event?.kind).toBe("key.revealed")
    expect(JSON.stringify(event)).not.toContain(key.value)
  })
})

describe("list and get", () => {
  test("never carry the value, only the display prefix", async () => {
    const { service } = harness()
    const key = await minted(service)

    const list = await service.list()
    const one = await service.get(key.id)

    expect(JSON.stringify(list)).not.toContain(key.value)
    expect(JSON.stringify(one)).not.toContain(key.value)
    expect(JSON.stringify(list)).toContain(key.prefix)
  })
})

describe("revoke", () => {
  test("is one-way and immediate, and refuses a second time", async () => {
    const { service, store } = harness()
    const key = await minted(service)

    const first = await service.revoke(key.id)
    expect(first.ok && first.value.revoked).toBe(true)
    expect(store.rows.keys[0]?.revoked).toBe(true)

    const second = await service.revoke(key.id)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.failure.code).toBe("already_revoked")
  })

  test("a revoked key is still readable — history stays joinable until it is purged", async () => {
    const { service } = harness()
    const key = await minted(service)
    await service.revoke(key.id)

    const revealed = await service.reveal(key.id)
    expect(revealed.ok && revealed.value.value).toBe(key.value)
  })
})

describe("audit", () => {
  test("one event per mutation, none of them carrying the key", async () => {
    const { service, store } = harness()
    const key = await minted(service)
    await service.update(key.id, { name: "renamed" })
    await service.revoke(key.id)
    await service.remove(key.id)

    expect(store.rows.audit.map((row) => row.kind)).toEqual([
      "key.created",
      "key.updated",
      "key.revoked",
      "key.deleted",
    ])
    expect(JSON.stringify(store.rows.audit)).not.toContain(key.value)
    expect(JSON.stringify(store.rows.audit)).not.toContain("v1.k1.")
  })
})

describe("write schemas", () => {
  test("a key must be named", () => {
    expect(createKeyBody.safeParse({}).success).toBe(false)
    expect(createKeyBody.safeParse({ name: "   " }).success).toBe(false)
  })

  test("a scope must be one of the three forms, with at least one target", () => {
    expect(createKeyBody.safeParse({ name: "k", scope: { kind: "everything" } }).success).toBe(
      false,
    )
    expect(
      createKeyBody.safeParse({ name: "k", scope: { kind: "pools", poolIds: [] } }).success,
    ).toBe(false)
    expect(
      createKeyBody.safeParse({ name: "k", scope: { kind: "pools", poolIds: ["not-a-uuid"] } })
        .success,
    ).toBe(false)
  })

  test("half a rate limit is not a rate limit", () => {
    expect(createKeyBody.safeParse({ name: "k", rateLimit: { requests: 10 } }).success).toBe(false)
    expect(
      createKeyBody.safeParse({ name: "k", rateLimit: { requests: 10, windowSeconds: 60 } })
        .success,
    ).toBe(true)
  })

  test("there is no way to set a value, and an empty update is refused", () => {
    expect(createKeyBody.safeParse({ name: "k", value: "mar_live_x" }).success).toBe(false)
    expect(updateKeyBody.safeParse({}).success).toBe(false)
  })
})
