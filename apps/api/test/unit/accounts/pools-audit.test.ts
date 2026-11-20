import { describe, expect, test } from "bun:test"
import { createAccountsService } from "../../../src/services/accounts"
import { createAuditRecorder } from "../../../src/services/admin"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import { accountDeletionFixture } from "../../support/account-deletion"
import { createMemoryConfigDirs } from "../../support/config-dirs"
import { createMemoryStore } from "../../support/memory-store"
import { silentLogger } from "../../support/silent-logger"
import { testSupportedModelsWriter } from "../../support/supported-models-writer"

/**
 * multi-ai-router#454: `account.disabled` and `account.deleted` name the pools the account was a
 * member of at that moment, as `{ poolId, name }`. A disabled account silently drops out of every
 * pool's candidates, and a deleted one leaves them for good (the `pool_members` cascade), so this is
 * the row that answers "which pools lost capacity, and when".
 */

const SECRET = "sk-live-pools-audit-upstream-key"
const NOW = new Date("2026-08-10T00:00:00.000Z")

async function harness() {
  const store = createMemoryStore()
  const configDirs = createMemoryConfigDirs()
  const service = createAccountsService({
    accounts: store.accounts,
    supportedModels: testSupportedModelsWriter(store.accounts),
    keys: store.keys,
    pools: store.pools,
    cipher: createCredentialCipher({ key: new Uint8Array(32).fill(9) }),
    configDirs: configDirs.dirs,
    ...accountDeletionFixture(configDirs.dirs),
    audit: createAuditRecorder(store.audit, silentLogger()),
    now: () => NOW,
  })
  const created = await service.create({ label: "din-claude", provider: "zai", credential: SECRET })
  if (!created.ok) throw new Error(`create failed: ${created.failure.message}`)
  const account = created.value
  const other = await store.accounts.create({ label: "seb-claude", provider: "zai" })
  const reviewers = await store.pools.create({ name: "reviewers" })
  const builders = await store.pools.create({ name: "builders" })
  const elsewhere = await store.pools.create({ name: "elsewhere" })
  await store.pools.replaceMembers(reviewers.id, [{ accountId: account.id }])
  await store.pools.replaceMembers(builders.id, [
    { accountId: other.id },
    { accountId: account.id },
  ])
  await store.pools.replaceMembers(elsewhere.id, [{ accountId: other.id }])
  const detail = (kind: string) => store.rows.audit.findLast((row) => row.kind === kind)?.detail
  const sortedPools = (rows: unknown) =>
    [...((rows ?? []) as { poolId: string; name: string }[])].sort((l, r) =>
      l.name.localeCompare(r.name),
    )
  return { store, service, account, reviewers, builders, detail, sortedPools }
}

describe("account.disabled and account.deleted name the pools the account was in", () => {
  test("an account disabled while in 2 pools lists both, and only those", async () => {
    const { store, service, account, reviewers, builders, detail, sortedPools } = await harness()

    expect((await service.disable(account.id)).ok).toBe(true)

    const row = detail("account.disabled")
    expect(row).toMatchObject({ label: "din-claude" })
    expect(sortedPools(row?.pools)).toEqual([
      { poolId: builders.id, name: "builders" },
      { poolId: reviewers.id, name: "reviewers" },
    ])
    const rendered = JSON.stringify(store.rows.audit)
    expect(rendered).not.toContain(SECRET)
    expect(rendered).not.toContain("v1.k1.")
    // Nothing in the new field was scrubbed by the redactor: names and ids only. (Scoped to this
    // row: `account.created` records `hasCredential`, a flag the redactor masks by its name.)
    expect(JSON.stringify(row)).not.toContain("[REDACTED]")
  })

  test("a delete lists the pools the account was in before the delete dropped its memberships", async () => {
    const { store, service, account, reviewers, builders, detail, sortedPools } = await harness()

    expect((await service.remove(account.id)).ok).toBe(true)

    expect(sortedPools(detail("account.deleted")?.pools)).toEqual([
      { poolId: builders.id, name: "builders" },
      { poolId: reviewers.id, name: "reviewers" },
    ])
    // The cascade happened: the account is in no pool any more.
    expect(store.rows.poolMembers.some((row) => row.accountId === account.id)).toBe(false)
    expect(JSON.stringify(store.rows.audit)).not.toContain(SECRET)
  })

  test("an account in no pool records an empty list, not a missing field", async () => {
    const { store, service, detail } = await harness()
    const lonely = await service.create({ label: "lonely", provider: "zai", credential: SECRET })
    if (!lonely.ok) throw new Error("setup failed")

    await service.disable(lonely.value.id)

    expect(detail("account.disabled")).toMatchObject({ label: "lonely", pools: [] })
    expect(store.rows.audit.at(-1)?.kind).toBe("account.disabled")
  })
})
