import { describe, expect, test } from "bun:test"
import { createAccountsService } from "../../../src/services/accounts"
import { createAuditRecorder } from "../../../src/services/admin"
import { createMemoryConfigDirs } from "../../support/config-dirs"
import { createMemoryStore } from "../../support/memory-store"
import { silentLogger } from "../../support/silent-logger"
import { testSupportedModelsWriter } from "../../support/supported-models-writer"

/**
 * prod, since v2.75.0: ownership asked the replica lease to revoke every deleted account, and only a
 * subscription account holds one. The row was gone, the operator read a 500 and no audit row existed.
 */
const LEASE = new Error("account replica ownership unavailable")

function harness(ownership: { revoke?: () => Promise<void>; barrier?: () => Promise<void> } = {}) {
  const store = createMemoryStore()
  const config = createMemoryConfigDirs()
  const calls: string[] = []
  const service = createAccountsService({
    accounts: store.accounts,
    supportedModels: testSupportedModelsWriter(store.accounts),
    keys: store.keys,
    pools: store.pools,
    cipher: { encrypt: (value) => value },
    configDirs: config.dirs,
    revokeDeletedAccount: async () => {
      calls.push("revoke")
      await (ownership.revoke ?? (() => Promise.reject(LEASE)))()
    },
    deletionCommitted: async () => {
      calls.push("barrier")
      await ownership.barrier?.()
    },
    cleanupDeletedAccount: async () => {
      calls.push("cleanup")
      throw LEASE
    },
    audit: createAuditRecorder(store.audit, silentLogger()),
    now: () => new Date("2026-11-23T00:00:00.000Z"),
  })
  const subscription = async () => {
    const row = await store.accounts.create({ provider: "anthropic-oauth", label: "sub" })
    const held = store.rows.accounts.find((account) => account.id === row.id)
    if (held === undefined) throw new Error("fixture missing")
    held.configDir = await config.dirs.provision(row.id)
    return row
  }
  const audited = () => store.rows.audit.filter((row) => row.kind === "account.deleted").length
  return { service, store, calls, subscription, audited }
}

describe("deleting an account, after the row is gone", () => {
  test("an HTTP account owns no directory: ownership is never asked, and the delete is audited", async () => {
    const h = harness()
    const row = await h.store.accounts.create({
      provider: "nvidia",
      label: "key",
      authMaterial: "x",
    })
    expect(await h.service.remove(row.id)).toEqual({
      ok: true,
      value: { id: row.id, deleted: true, cleanup: "not_applicable" },
    })
    expect(h.calls).toEqual(["barrier"])
    expect(h.audited()).toBe(1)
  })

  test("a subscription whose lease is momentarily elsewhere is deferred to the reaper, not a 500", async () => {
    const h = harness()
    const row = await h.subscription()
    expect(await h.service.remove(row.id)).toMatchObject({
      ok: true,
      value: { cleanup: "deferred" },
    })
    expect(h.calls).toEqual(["revoke", "barrier"])
    expect(h.audited()).toBe(1)
  })

  test("a cleanup that throws is deferred too", async () => {
    const h = harness({ revoke: async () => {} })
    const row = await h.subscription()
    expect(await h.service.remove(row.id)).toMatchObject({
      ok: true,
      value: { cleanup: "deferred" },
    })
    expect(h.calls).toEqual(["revoke", "barrier", "cleanup"])
  })

  test("a routing barrier that fails is still raised, after the audit row", async () => {
    const h = harness({
      barrier: async () => {
        throw new Error("catalog unavailable")
      },
    })
    const row = await h.store.accounts.create({ provider: "nvidia", label: "key" })
    await expect(h.service.remove(row.id)).rejects.toThrow("catalog unavailable")
    expect(h.audited()).toBe(1)
  })

  test("a revoked key in scope blocks nothing; a live one does", async () => {
    const h = harness()
    const row = await h.store.accounts.create({ provider: "nvidia", label: "key" })
    const key = await h.store.keys.create({ name: "k", value: "v", prefix: "p", scope: "accounts" })
    await h.store.keys.replaceScopeTargets(key.id, { accountIds: [row.id] })
    expect(await h.service.remove(row.id)).toMatchObject({
      ok: false,
      failure: { code: "account_in_use" },
    })
    await h.store.keys.markRevoked(key.id, new Date())
    expect(await h.service.remove(row.id)).toMatchObject({ ok: true })
  })
})
