import { expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import type { CredentialMetadata } from "../../../src/providers/claude-sdk/credential-metadata"
import {
  createCredentialPark,
  withCredentialMetadata,
} from "../../../src/services/accounts/credential"
import type { AccountsService } from "../../../src/services/accounts/service"
import { toAccountView } from "../../../src/services/accounts/view"
import { ok } from "../../../src/services/admin/result"
import { createMemoryConfigDirs } from "../../support/config-dirs"
import { createMemoryStore } from "../../support/memory-store"

const NOW = new Date("2026-10-03T12:00:00Z")
const LIVE: CredentialMetadata = {
  hasTokens: true,
  subscriptionType: "max",
  rateLimitTier: null,
  refreshTokenExpiresAt: null,
}
const DEAD: CredentialMetadata = { ...LIVE, hasTokens: false }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function harness(reader: () => Promise<CredentialMetadata>, auditFails = false) {
  const store = createMemoryStore()
  const row = await store.accounts.create({ label: "Claude", provider: "anthropic-oauth" })
  const events: string[] = []
  let batches = 0
  const unreachable = async (): Promise<never> => {
    throw new Error("unused write")
  }
  const base: AccountsService = {
    list: async () => ok((await store.accounts.list()).map(toAccountView)),
    get: async (id) => {
      const row = await store.accounts.findById(id)
      if (row === undefined) throw new Error("missing fixture")
      return ok(toAccountView(row))
    },
    create: unreachable,
    update: unreachable,
    disable: unreachable,
    remove: unreachable,
  }
  const service = withCredentialMetadata(base, {
    accounts: {
      findById: store.accounts.findById,
      findByIds: async (ids) => {
        batches += 1
        return store.accounts.findByIds(ids)
      },
    },
    reader: { read: reader },
    configDirs: createMemoryConfigDirs().dirs,
    ttlMs: 60_000,
    now: () => NOW,
    park: createCredentialPark({
      accounts: store.accounts,
      refreshCatalog: async () => {
        events.push("barrier")
      },
      audit: {
        record: async () => {
          events.push("audit")
          if (auditFails) throw new Error("audit unavailable")
        },
      },
    }),
  })
  return { store, row, service, events, batches: () => batches }
}

for (const intent of ["reconnect", "disable", "replace", "delete"] as const) {
  test(`blank metadata observed before ${intent} cannot park the newer row`, async () => {
    const started = deferred<void>()
    const response = deferred<CredentialMetadata>()
    const h = await harness(async () => {
      started.resolve()
      return response.promise
    })
    const reading = h.service.get(h.row.id)
    await started.promise
    if (intent === "reconnect") {
      await h.store.accounts.confirmAccountAuthorization({
        id: h.row.id,
        expected: h.row,
        now: NOW,
      })
    } else if (intent === "delete") {
      await h.store.accounts.delete(h.row.id)
    } else {
      await h.store.accounts.updateOperatorAccount({
        id: h.row.id,
        patch: intent === "disable" ? { status: "disabled" } : { authMaterial: "new-envelope" },
        now: NOW,
      })
    }
    response.resolve(DEAD)
    await reading
    const current = await h.store.accounts.findById(h.row.id)
    expect(current?.status).toBe(
      intent === "delete" ? undefined : intent === "disable" ? "disabled" : "active",
    )
    expect(h.events).toEqual([])
  })
}

test("new authorization invalidates positive cached metadata; old read cannot overwrite fresh cache", async () => {
  const firstStarted = deferred<void>()
  const old = deferred<CredentialMetadata>()
  let reads = 0
  const h = await harness(async () => {
    reads += 1
    if (reads === 1) {
      firstStarted.resolve()
      return old.promise
    }
    return LIVE
  })
  const first = h.service.get(h.row.id)
  await firstStarted.promise
  await h.store.accounts.confirmAccountAuthorization({ id: h.row.id, expected: h.row, now: NOW })
  await h.service.get(h.row.id)
  old.resolve(DEAD)
  await first
  const latest = await h.service.get(h.row.id)
  expect(latest.ok && latest.value.credential?.present).toBe(true)
  expect(reads).toBe(2)
  expect(h.events).toEqual([])

  const current = await h.store.accounts.findById(h.row.id)
  if (current === undefined) throw new Error("missing current fixture")
  await h.store.accounts.confirmAccountAuthorization({
    id: current.id,
    expected: current,
    now: NOW,
  })
  await h.service.get(current.id)
  expect(reads).toBe(3)
})

test("list captures private subjects in one batch and keeps them out of DTOs", async () => {
  const h = await harness(async () => LIVE)
  await h.store.accounts.create({ label: "second", provider: "anthropic-oauth" })
  await h.store.accounts.create({
    label: "key",
    provider: "openai-api",
    authMaterial: "private-envelope",
  })
  const listed = await h.service.list({})
  expect(h.batches()).toBe(1)
  const serialized = JSON.stringify(listed)
  for (const internal of [
    "lifecycleVersion",
    "healthRecoveryVersion",
    "authRecoveryVersion",
    "authorizationAttemptId",
    "authMaterial",
    "private-envelope",
  ]) {
    expect(serialized).not.toContain(internal)
  }
})

test("parking refreshes the catalog before a later audit failure", async () => {
  const h = await harness(async () => DEAD, true)
  await expect(h.service.get(h.row.id)).rejects.toThrow("audit unavailable")
  expect(h.events).toEqual(["barrier", "audit"])
  expect(await h.store.accounts.findById(h.row.id)).toMatchObject({ status: "needs_reauth" })
})

test("captured disabled subject cannot be parked even if durable state later becomes active", async () => {
  const h = await harness(async () => LIVE)
  const disabled: AccountRow = { ...h.row, status: "disabled" }
  const park = createCredentialPark({
    accounts: h.store.accounts,
    audit: {
      record: async () => {
        throw new Error("must not audit")
      },
    },
  })
  expect(await park(disabled, NOW)).toBe(false)
})
