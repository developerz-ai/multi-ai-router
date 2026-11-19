import { describe, expect, test } from "bun:test"
import { createAuditRecorder } from "../../../src/services/admin"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import { createKeysService } from "../../../src/services/keys"
import { createMemoryStore } from "../../support/memory-store"
import { silentLogger } from "../../support/silent-logger"

/**
 * multi-ai-router#454: `key.updated` for a scope change names the pools and accounts the scope
 * gained and lost, as ids and names. Never the key's value, its ciphertext or its prefix.
 */

const NOW = new Date("2026-08-10T00:00:00.000Z")
const VALUE = `mar_live_scopeaudit${"0".repeat(22)}`

async function harness() {
  const store = createMemoryStore()
  const service = createKeysService({
    logger: silentLogger(),
    mutations: store.mutations,
    onCommitted: () => {},
    keys: store.keys,
    cipher: createCredentialCipher({ key: new Uint8Array(32).fill(5) }),
    audit: createAuditRecorder(store.audit, silentLogger()),
    now: () => NOW,
    generate: () => VALUE,
  })
  const reviewers = await store.pools.create({ name: "reviewers" })
  const builders = await store.pools.create({ name: "builders" })
  const din = await store.accounts.create({ label: "din-claude", provider: "zai" })
  const seb = await store.accounts.create({ label: "seb-claude", provider: "zai" })
  const lastUpdate = () => store.rows.audit.findLast((row) => row.kind === "key.updated")?.detail
  const leaksNothing = () => {
    const rows = JSON.stringify(store.rows.audit)
    const stored = store.rows.keys[0]
    expect(rows).not.toContain(VALUE)
    expect(rows).not.toContain(VALUE.slice(0, 12))
    if (stored !== undefined) expect(rows).not.toContain(stored.value)
    expect(rows).not.toContain("[REDACTED]")
  }
  return { store, service, reviewers, builders, din, seb, lastUpdate, leaksNothing }
}

describe("key.updated names the scope targets a scope edit added and removed", () => {
  test("a widen lists the pool it added and removes nothing", async () => {
    const { service, reviewers, builders, lastUpdate, leaksNothing } = await harness()
    const key = await service.create({
      name: "dz-team",
      scope: { kind: "pools", poolIds: [reviewers.id] },
    })
    if (!key.ok) throw new Error("setup failed")

    await service.update(key.value.id, {
      scope: { kind: "pools", poolIds: [reviewers.id, builders.id] },
    })

    expect(lastUpdate()).toMatchObject({
      scopeBefore: "pools",
      scope: "pools",
      poolsAdded: [{ poolId: builders.id, name: "builders" }],
      poolsRemoved: [],
      accountsAdded: [],
      accountsRemoved: [],
    })
    leaksNothing()
  })

  test("a narrow lists the account it removed", async () => {
    const { service, din, seb, lastUpdate, leaksNothing } = await harness()
    const key = await service.create({
      name: "dz-team",
      scope: { kind: "accounts", accountIds: [din.id, seb.id] },
    })
    if (!key.ok) throw new Error("setup failed")

    await service.update(key.value.id, { scope: { kind: "accounts", accountIds: [seb.id] } })

    expect(lastUpdate()).toMatchObject({
      scopeBefore: "accounts",
      scope: "accounts",
      poolsAdded: [],
      poolsRemoved: [],
      accountsAdded: [],
      accountsRemoved: [{ accountId: din.id, name: "din-claude" }],
    })
    leaksNothing()
  })

  test("a pools-to-all widen says so through scopeBefore, not only through poolsRemoved", async () => {
    const { service, reviewers, lastUpdate } = await harness()
    const key = await service.create({
      name: "dz-team",
      scope: { kind: "pools", poolIds: [reviewers.id] },
    })
    if (!key.ok) throw new Error("setup failed")

    await service.update(key.value.id, { scope: { kind: "all" } })

    expect(lastUpdate()).toMatchObject({
      scopeBefore: "pools",
      scope: "all",
      poolsRemoved: [{ poolId: reviewers.id, name: "reviewers" }],
    })
  })

  test("an edit that does not send a scope records no scope lists", async () => {
    const { service, lastUpdate } = await harness()
    const key = await service.create({ name: "dz-team" })
    if (!key.ok) throw new Error("setup failed")

    await service.update(key.value.id, { name: "dz-team-2" })

    const row = lastUpdate()
    for (const field of ["scopeBefore", "poolsAdded", "poolsRemoved", "accountsAdded"]) {
      expect(row).not.toHaveProperty(field)
    }
  })
})
