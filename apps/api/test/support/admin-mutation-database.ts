import {
  type AdminMutationRepository,
  type AdminMutationScope,
  createAccountRepository,
  createAdminMutationRepository,
  createApiKeyRepository,
  createAuditRepository,
  createDatabase,
  createPoolRepository,
} from "@multi-ai-router/db"
import { createAuditRecorder } from "../../src/services/admin"
import { createCredentialCipher } from "../../src/services/crypto/cipher"
import { createKeysService } from "../../src/services/keys"
import { createPoolsService } from "../../src/services/pools"

export function adminMutationDatabase(url: string, maxConnections = 2) {
  const handle = createDatabase({ url, maxConnections })
  const accounts = createAccountRepository(handle.db)
  const keys = createApiKeyRepository(handle.db)
  const pools = createPoolRepository(handle.db)
  const audit = createAuditRepository(handle.db)
  const repository = createAdminMutationRepository(handle.db)
  const subjects = new Set<string>()
  const accountIds = new Set<string>()
  const prefix = `test-admin-atomic-${crypto.randomUUID()}-`
  const committed: string[] = []
  let transform = (scope: AdminMutationScope): AdminMutationScope => scope
  const mutations: AdminMutationRepository = {
    run: (subject, work) =>
      repository.run(subject, (scope) =>
        work(
          transform({
            ...scope,
            keys: {
              ...scope.keys,
              create: async (input) => {
                const row = await scope.keys.create(input)
                subjects.add(row.id)
                return row
              },
            },
            pools: {
              ...scope.pools,
              create: async (input) => {
                const row = await scope.pools.create(input)
                subjects.add(row.id)
                return row
              },
            },
          }),
        ),
      ),
  }
  const now = () => new Date("2026-10-03T00:00:00Z")
  const onCommitted = (id: string, kind: string) => {
    committed.push(`${kind}:${id}`)
  }
  return {
    handle,
    repository,
    mutations,
    accounts,
    keys,
    pools,
    audit,
    committed,
    name: (suffix: string) => `${prefix}${suffix}`,
    transform: (next: typeof transform) => {
      transform = next
    },
    keyService: createKeysService({
      keys,
      mutations,
      onCommitted,
      now,
      cipher: createCredentialCipher({ key: new Uint8Array(32).fill(3) }),
      audit: createAuditRecorder(audit),
    }),
    poolService: createPoolsService({ pools, accounts, mutations, onCommitted, now }),
    seedAccount: async () => {
      const row = await accounts.create({ label: prefix, provider: "zai" })
      accountIds.add(row.id)
      return row
    },
    snapshot: async () => {
      const keyRows = (await keys.list()).filter((row) => subjects.has(row.id))
      const poolRows = (await pools.list()).filter((row) => subjects.has(row.id))
      return {
        keys: keyRows,
        pools: poolRows,
        targets: await keys.listTargetsForKeys(keyRows.map((row) => row.id)),
        members: await pools.listMembersForPools(poolRows.map((row) => row.id)),
        audit: (await Promise.all([...subjects].map((id) => audit.listForSubject(id, 100)))).flat(),
      }
    },
    close: async () => {
      try {
        for (const id of subjects) {
          await handle.sql`delete from audit_events where subject_id = ${id}`
          await keys.delete(id)
        }
        for (const id of subjects) await pools.delete(id)
        for (const id of accountIds) await accounts.delete(id)
      } finally {
        await handle.close()
      }
    },
  }
}

export function deferred() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
