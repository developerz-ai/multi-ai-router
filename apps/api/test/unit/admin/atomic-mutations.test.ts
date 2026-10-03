import { expect, test } from "bun:test"
import type { AdminMutationRepository, AdminMutationScope } from "@multi-ai-router/db"
import { createAuditRecorder } from "../../../src/services/admin"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import { createKeysService } from "../../../src/services/keys"
import { createPoolsService } from "../../../src/services/pools"
import { createMemoryStore } from "../../support/memory-store"

const now = () => new Date("2026-10-03T00:00:00Z")

function harness() {
  const store = createMemoryStore()
  let failAudit = false
  let transform = (scope: AdminMutationScope): AdminMutationScope => scope
  const committed: string[] = []
  const mutations: AdminMutationRepository = {
    run: (subject, work) =>
      store.mutations.run(subject, (scope) =>
        work(
          transform({
            ...scope,
            audit: {
              append: async (input) => {
                const row = await scope.audit.append(input)
                if (failAudit) throw new Error("audit unavailable")
                return row
              },
            },
          }),
        ),
      ),
  }
  const onCommitted = (id: string, kind: string) => {
    committed.push(`${kind}:${id}`)
  }
  const keys = createKeysService({
    keys: store.keys,
    mutations,
    onCommitted,
    cipher: createCredentialCipher({ key: new Uint8Array(32).fill(3) }),
    audit: createAuditRecorder(store.audit),
    now,
  })
  const pools = createPoolsService({
    pools: store.pools,
    accounts: store.accounts,
    mutations,
    onCommitted,
    now,
  })
  return {
    store,
    keys,
    pools,
    committed,
    failAudit: () => {
      failAudit = true
    },
    transform: (next: typeof transform) => {
      transform = next
    },
  }
}

for (const kind of ["create", "update", "revoke", "remove"] as const) {
  test(`key ${kind} rolls back scope and audit together on append failure`, async () => {
    const h = harness()
    const account = await h.store.accounts.create({ label: "test", provider: "zai" })
    const seed = await h.keys.create({
      name: "before",
      scope: { kind: "accounts", accountIds: [account.id] },
    })
    if (!seed.ok) throw new Error("seed failed")
    const before = structuredClone(h.store.rows)
    const commits = h.committed.length
    h.failAudit()
    const operation =
      kind === "create"
        ? h.keys.create({ name: "after" })
        : kind === "update"
          ? h.keys.update(seed.value.id, { name: "after", scope: { kind: "all" } })
          : h.keys[kind](seed.value.id)
    await expect(operation).rejects.toThrow("audit unavailable")
    expect(h.store.rows).toEqual(before)
    expect(h.committed).toHaveLength(commits)
  })
}

for (const kind of ["create", "update", "remove"] as const) {
  test(`pool ${kind} rolls back membership and audit together on append failure`, async () => {
    const h = harness()
    const account = await h.store.accounts.create({ label: "test", provider: "zai" })
    const seed = await h.pools.create({ name: "before", members: [{ accountId: account.id }] })
    if (!seed.ok) throw new Error("seed failed")
    const before = structuredClone(h.store.rows)
    const commits = h.committed.length
    h.failAudit()
    const operation =
      kind === "create"
        ? h.pools.create({ name: "after", members: [{ accountId: account.id }] })
        : kind === "update"
          ? h.pools.update(seed.value.id, { name: "after", members: [], policy: "weighted" })
          : h.pools.remove(seed.value.id)
    await expect(operation).rejects.toThrow("audit unavailable")
    expect(h.store.rows).toEqual(before)
    expect(h.committed).toHaveLength(commits)
  })
}

test("the second policy audit event cannot commit half a pool mutation", async () => {
  const h = harness()
  const seed = await h.pools.create({ name: "before" })
  if (!seed.ok) throw new Error("seed failed")
  const before = structuredClone(h.store.rows)
  h.transform((scope) => ({
    ...scope,
    audit: {
      append: async (input) => {
        if (input.kind === "policy.changed") throw new Error("second append failed")
        return scope.audit.append(input)
      },
    },
  }))
  await expect(h.pools.update(seed.value.id, { policy: "weighted" })).rejects.toThrow(
    "second append failed",
  )
  expect(h.store.rows).toEqual(before)
  expect(h.committed).toHaveLength(1)
})

for (const kind of ["key", "pool"] as const) {
  test(`${kind} commit notification precedes even a failing response render`, async () => {
    const h = harness()
    h.transform((scope) =>
      kind === "key"
        ? {
            ...scope,
            keys: {
              ...scope.keys,
              create: async (input) => ({
                ...(await scope.keys.create(input)),
                createdAt: new Date(NaN),
              }),
            },
          }
        : {
            ...scope,
            pools: {
              ...scope.pools,
              create: async (input) => ({
                ...(await scope.pools.create(input)),
                createdAt: new Date(NaN),
              }),
            },
          },
    )
    await expect(
      (kind === "key" ? h.keys : h.pools).create({ name: "committed" }),
    ).rejects.toThrow()
    expect(h.committed).toHaveLength(1)
    expect(kind === "key" ? h.store.rows.keys : h.store.rows.pools).toHaveLength(1)
    expect(h.store.rows.audit).toHaveLength(1)
  })
}

test("transactional audit still redacts credential-shaped names", async () => {
  const h = harness()
  const sensitive = `sk-${"a".repeat(36)}`
  await h.keys.create({ name: sensitive })
  await h.pools.create({ name: sensitive })
  expect(JSON.stringify(h.store.rows.audit)).not.toContain(sensitive)
  expect(JSON.stringify(h.store.rows.audit)).toContain("[REDACTED]")
})
