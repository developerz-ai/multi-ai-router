import { expect, test } from "bun:test"
import { createAccountsService } from "../../../src/services/accounts/service"
import { createMemoryConfigDirs } from "../../support/config-dirs"
import { createMemoryStore } from "../../support/memory-store"

for (const auditFailure of [false, true]) {
  test(`durable deletion/barrier precedes deferred owned-directory cleanup even auditFailure=${auditFailure}`, async () => {
    const store = createMemoryStore()
    const config = createMemoryConfigDirs()
    const row = await store.accounts.create(
      { provider: "anthropic-oauth", label: "fixture" },
      new Date(),
    )
    const directory = await config.dirs.provision(row.id)
    const original = store.rows.accounts.find((account) => account.id === row.id)
    if (!original) throw new Error("fixture missing")
    original.configDir = directory
    const events: string[] = []
    const service = createAccountsService({
      accounts: store.accounts,
      keys: store.keys,
      cipher: { encrypt: (value) => value },
      configDirs: config.dirs,
      revokeDeletedAccount: async ({ id }) => {
        expect(await store.accounts.findById(id)).toBeUndefined()
        events.push("tombstone_and_admission_closed")
      },
      deletionCommitted: async (id) => {
        expect(await store.accounts.findById(id)).toBeUndefined()
        events.push("catalog_and_sessions_invalidated")
      },
      cleanupDeletedAccount: async () => {
        expect(events).toEqual([
          "tombstone_and_admission_closed",
          "catalog_and_sessions_invalidated",
        ])
        events.push("cleanup_deferred_owned_directory")
        return "deferred"
      },
      audit: {
        record: async () => {
          expect(events).toEqual([
            "tombstone_and_admission_closed",
            "catalog_and_sessions_invalidated",
            "cleanup_deferred_owned_directory",
          ])
          events.push("audit")
          if (auditFailure) throw new Error("audit unavailable")
        },
      },
      now: () => new Date(),
    })
    const result = service.remove(row.id)
    if (auditFailure) await expect(result).rejects.toThrow("audit unavailable")
    else {
      const deleted = await result
      expect(deleted.ok).toBe(true)
      if (deleted.ok) expect(deleted.value.cleanup).toBe("deferred")
      expect(JSON.stringify(deleted)).not.toContain(directory)
    }
    expect(await store.accounts.findById(row.id)).toBeUndefined()
    expect(config.present.has(directory)).toBe(true)
    expect(events).toHaveLength(4)
    expect(
      await store.accounts.confirmAccountAuthorization({
        id: row.id,
        expected: {
          lifecycleVersion: original.lifecycleVersion,
          authMaterial: original.authMaterial,
          status: original.status,
        },
        now: new Date(),
      }),
    ).toBeUndefined()
  })
}
