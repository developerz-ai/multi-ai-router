import { describe, expect, test } from "bun:test"
import { createAccountsService } from "../../../src/services/accounts/service"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import { accountDeletionFixture } from "../../support/account-deletion"
import { createMemoryConfigDirs } from "../../support/config-dirs"
import { createMemoryStore } from "../../support/memory-store"

const NOW = new Date("2026-10-03T12:00:00Z")
function harness(options: { auditFails?: boolean; barrierFails?: boolean } = {}) {
  const store = createMemoryStore()
  const events: string[] = []
  const dirs = createMemoryConfigDirs()
  const service = createAccountsService({
    accounts: store.accounts,
    keys: store.keys,
    configDirs: dirs.dirs,
    ...accountDeletionFixture(dirs.dirs),
    cipher: createCredentialCipher({ key: new Uint8Array(32).fill(7) }),
    now: () => NOW,
    deletionCommitted: async (id) => {
      events.push(`barrier:${id}`)
      if (options.barrierFails) throw new Error("catalog unavailable")
    },
    mutationCommitted: async (id) => {
      events.push(`barrier:${id}`)
      if (options.barrierFails) throw new Error("catalog unavailable")
    },
    audit: {
      record: async () => {
        events.push("audit")
        if (options.auditFails) throw new Error("audit unavailable")
      },
    },
  })
  return { store, events, dirs, service }
}

async function seeded(store: ReturnType<typeof createMemoryStore>) {
  return store.accounts.create({
    label: "OAuth account",
    provider: "openai-oauth",
    authMaterial: "old-encrypted-envelope",
    status: "disabled",
    tokenExpiresAt: new Date(NOW.getTime() + 60_000),
  })
}

describe("operator credential and status intent", () => {
  test("replacement preserves disabled and clears expiry; combined enable increments each intent once", async () => {
    const { store, service } = harness()
    const initial = await seeded(store)
    expect((await service.update(initial.id, { credential: "fixture-replacement" })).ok).toBe(true)
    const replaced = await store.accounts.findById(initial.id)
    expect(replaced).toMatchObject({
      status: "disabled",
      tokenExpiresAt: null,
      lifecycleVersion: 1,
      healthRecoveryVersion: 0,
      authRecoveryVersion: 1,
    })

    await service.update(initial.id, { credential: "fixture-new-credential", status: "active" })
    expect(await store.accounts.findById(initial.id)).toMatchObject({
      status: "active",
      lifecycleVersion: 2,
      healthRecoveryVersion: 1,
      authRecoveryVersion: 2,
    })
    await service.update(initial.id, { label: "renamed" })
    expect(await store.accounts.findById(initial.id)).toMatchObject({
      lifecycleVersion: 2,
      healthRecoveryVersion: 1,
      authRecoveryVersion: 2,
    })
    await service.update(initial.id, { status: "active" })
    expect(await store.accounts.findById(initial.id)).toMatchObject({
      lifecycleVersion: 3,
      healthRecoveryVersion: 2,
      authRecoveryVersion: 2,
    })
  })

  test("audit failure cannot skip the routing barrier for a committed operator edit", async () => {
    const { store, service, events } = harness({ auditFails: true })
    const initial = await seeded(store)
    await expect(service.update(initial.id, { status: "active" })).rejects.toThrow(
      "audit unavailable",
    )
    expect(events).toEqual([`barrier:${initial.id}`, "audit"])
    expect(await store.accounts.findById(initial.id)).toMatchObject({
      status: "active",
      lifecycleVersion: 1,
    })
  })

  test("failed barrier leaves the committed row and suppresses audit and ready response", async () => {
    const { store, service, events } = harness({ barrierFails: true })
    const initial = await seeded(store)
    await expect(service.disable(initial.id)).rejects.toThrow("catalog unavailable")
    expect(events).toEqual([`barrier:${initial.id}`])
    expect(await store.accounts.findById(initial.id)).toMatchObject({
      status: "disabled",
      lifecycleVersion: 1,
    })
  })

  test("committed subscription directory survives postcommit audit failure", async () => {
    const { store, service, dirs, events } = harness({ auditFails: true })
    await expect(
      service.create({ label: "Claude account", provider: "anthropic-oauth" }),
    ).rejects.toThrow("audit unavailable")
    const row = store.rows.accounts[0]
    expect(row).toBeDefined()
    expect(dirs.present.has(row?.configDir ?? "")).toBe(true)
    expect(events).toEqual([`barrier:${row?.id}`, "audit"])
  })

  test("rejected writes do not trigger a committed callback", async () => {
    const { service, events } = harness()
    expect((await service.update("missing", { status: "active" })).ok).toBe(false)
    expect(
      (
        await service.create({
          label: "bad shape",
          provider: "openai-compatible",
          credential: "fixture",
        })
      ).ok,
    ).toBe(false)
    expect(events).toEqual([])
  })
  test("delete crosses the barrier before an audit failure after the row disappears", async () => {
    const { store, service, events } = harness({ auditFails: true })
    const initial = await seeded(store)
    await expect(service.remove(initial.id)).rejects.toThrow("audit unavailable")
    expect(await store.accounts.findById(initial.id)).toBeUndefined()
    expect(events).toEqual([`barrier:${initial.id}`, "audit"])
  })
})
